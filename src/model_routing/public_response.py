"""Explicit protocol identity fields, inside the existing safe response boundary."""
from copy import deepcopy
import json

from fastapi import Response
from fastapi.responses import StreamingResponse

from src.httpx_client import iter_sse_frames
from src.model_routing.stream_runtime import bad_stream
from src.router.model_api_errors import (
    ModelApiErrorException, ModelApiProtocol, _close_response_resources,
    error_from_model_payload, error_from_response, error_from_retirement_payload,
    get_attached_model_api_error, get_rendered_error_event, get_rendered_error_event_protocol, is_rendered_model_api_error,
    parse_model_response, protect_streaming_response, render_error,
)
from src.router.stream_passthrough import prepend_async_item, read_first_async_item


def rewrite_success_identity(payload, *, protocol, requested_model) -> dict:
    """Copy a successful object and rewrite only protocol identity locations."""
    protocol = ModelApiProtocol(protocol)
    error = error_from_model_payload(payload)
    if error is None and protocol == ModelApiProtocol.GEMINI:
        error = error_from_retirement_payload(payload)
    if error is not None:
        raise ModelApiErrorException(error)
    result = deepcopy(payload)
    if protocol == ModelApiProtocol.GEMINI:
        for obj in (result, result.get("response")):
            if not isinstance(obj, dict):
                continue
            if "model" in obj:
                obj["model"] = requested_model
            if "modelVersion" in obj or any(key in obj for key in ("candidates", "promptFeedback", "usageMetadata")):
                obj["modelVersion"] = requested_model
    elif protocol == ModelApiProtocol.OPENAI:
        result["model"] = requested_model
    else:
        if "model" in result or result.get("type") == "message":
            result["model"] = requested_model
        if result.get("type") == "message_start":
            if not isinstance(result.get("message"), dict):
                raise bad_stream()
            result["message"]["model"] = requested_model
    return result


async def _identity_events(iterator, *, protocol, requested_model, close_source):
    """Share the transport framer while keeping final protocol SSE controls."""
    class RenderedEventExit(Exception):
        def __init__(self, event):
            self.event = event

    async def fragments():
        async for item in iterator:
            if isinstance(item, Response):
                raise ModelApiErrorException(error_from_response(item))
            error = get_rendered_error_event(item)
            if error is not None:
                if get_rendered_error_event_protocol(item) != protocol:
                    # Keep the trusted type at a protocol-conversion boundary.
                    raise ModelApiErrorException(error)
                raise RenderedEventExit(item)
            yield item

    source = fragments()
    frames = iter_sse_frames(source)
    done_frame = None
    saw_payload = False
    try:
        async for frame in frames:
            lines = frame.rstrip("\n").split("\n")
            data = []
            controls = []
            event_name = ""
            for line in lines:
                field, separator, value = line.partition(":")
                if value.startswith(" "):
                    value = value[1:]
                if separator and field == "data":
                    data.append(value)
                else:
                    controls.append(line)
                    if field == "event":
                        event_name = value
            if not data:
                yield frame.encode("utf-8")
                continue
            raw = "\n".join(data)
            if event_name == "error":
                # Only a private rendered-event marker can bypass classification.
                parse_model_response(raw)
                raise bad_stream()
            if raw.strip() == "[DONE]":
                done_frame = frame.encode("utf-8")
                continue
            if done_frame is not None:
                raise bad_stream()
            payload = rewrite_success_identity(parse_model_response(raw), protocol=protocol, requested_model=requested_model)
            saw_payload = True
            encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
            yield ("\n".join([*controls, "data: " + encoded]) + "\n\n").encode("utf-8")
        if not saw_payload:
            raise bad_stream()
        if done_frame is not None:
            # Drain the existing tracked source to EOF so it finalizes its one
            # logical outcome, rather than closing it at its suspended DONE.
            yield done_frame
    except RenderedEventExit as exc:
        # Forward the exact fixed renderer output with its private provenance.
        yield exc.event
    finally:
        for owned in (frames, source, iterator):
            await close_source(owned)


async def adapt_public_response(response, *, route_context) -> Response:
    """Preserve the original Response and install identity inside protection."""
    if route_context is None:
        return response
    if route_context.channel not in ("geminicli", "antigravity"):
        raise ValueError("Unsupported model routing channel.")
    protocol = ModelApiProtocol(route_context.protocol)
    requested_model = route_context.requested_model
    if is_rendered_model_api_error(response):
        return response
    attached = get_attached_model_api_error(response)
    if not 200 <= response.status_code < 300:
        return response
    if attached is not None:
        await _close_response_resources(response)
        return render_error(attached, protocol)
    identity = (protocol, requested_model)
    previous = getattr(response, "_model_api_public_identity", None)
    if previous is not None:
        if previous != identity:
            raise bad_stream()
        return response
    if isinstance(response, StreamingResponse):
        prefetched = None
        closed_sources = set()
        async def close_source(source):
            close = getattr(source, "aclose", None)
            if close is not None and id(source) not in closed_sources:
                closed_sources.add(id(source))
                try:
                    await close()
                except Exception:
                    pass
        def adapter(iterator):
            return _identity_events(iterator, protocol=protocol, requested_model=requested_model, close_source=close_source)
        if getattr(response, "_model_api_stream_protected", False):
            # The central boundary consults this before starting its iterator.
            response._model_api_success_adapter = adapter
        else:
            stream = adapter(response.body_iterator)
            prefetched = stream
            try:
                first = await read_first_async_item(stream)
            except (ModelApiErrorException, StopAsyncIteration) as exc:
                failure = getattr(response, "_model_api_stream_failure", None)
                if failure is not None:
                    try:
                        await failure()
                    except Exception:
                        pass
                await stream.aclose()
                await _close_response_resources(response)
                return render_error(exc.error if isinstance(exc, ModelApiErrorException) else bad_stream().error, protocol)
            except BaseException:
                await stream.aclose()
                await _close_response_resources(response)
                raise
            response.body_iterator = prepend_async_item(first, stream)
        if "content-length" in response.headers:
            del response.headers["content-length"]
        response._model_api_public_identity = identity
        await protect_streaming_response(response, protocol)
        original_class = type(response)

        class IdentityClosingResponse(original_class):
            __slots__ = ()
            async def __call__(self, scope, receive, send):
                try:
                    await super().__call__(scope, receive, send)
                finally:
                    # Headers can fail before any iterator's finally starts.
                    for source in (self.body_iterator, prefetched, getattr(self, "_model_api_stream_original_iterator", None)):
                        await close_source(source)
                    cleanup = getattr(self, "_model_api_stream_resource_close", None)
                    if cleanup is not None:
                        try:
                            await cleanup()
                        except Exception:
                            pass
        response.__class__ = IdentityClosingResponse
        return response
    payload = rewrite_success_identity(parse_model_response(response.body), protocol=protocol, requested_model=requested_model)
    response.body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    response.headers["content-length"] = str(len(response.body))
    response._model_api_public_identity = identity
    return response
