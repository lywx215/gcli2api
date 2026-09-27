import asyncio
import json

import pytest
from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.testclient import TestClient
from starlette.background import BackgroundTask

from src.router.model_api_errors import (
    ErrorKind,
    ErrorOrigin,
    FIXED_ERROR_MESSAGES,
    ModelApiError,
    ModelApiErrorException,
    ModelApiProtocol,
    ProtectedModelApiRoute,
    activate_logical_request_recording,
    attach_model_api_error,
    error_from_http_status,
    get_attached_model_api_error,
    fixed_error_message,
    make_model_api_error,
    make_protected_model_api_route_class,
    protect_streaming_response,
    record_logical_request_once,
    render_error,
    render_error_event,
)


def error(status=400, *, origin=ErrorOrigin.UPSTREAM, kind=ErrorKind.HTTP):
    return make_model_api_error(origin=origin, kind=kind, status=status)


def test_fixed_english_messages_are_exact_and_error_is_immutable():
    assert len(FIXED_ERROR_MESSAGES) == 13
    value = error(400)
    assert fixed_error_message(value) == (
        "Invalid request. Check the request parameters and try again."
    )
    with pytest.raises(Exception):
        value.status = 401


@pytest.mark.parametrize(
    "status,expected_message",
    [
        (400, "Invalid request. Check the request parameters and try again."),
        (401, "The service could not process the request. Please contact the service administrator."),
        (402, "The request cannot be completed due to a payment requirement. Please contact the service administrator."),
        (403, "The service could not process the request. Please contact the service administrator."),
        (404, "The requested resource is unavailable."),
        (408, "The request timed out. Please try again later."),
        (413, "The request is too large. Reduce its size and try again."),
        (422, "Invalid request. Check the request parameters and try again."),
        (429, "The request limit has been reached. Please contact the service administrator if the issue persists."),
        (500, "An internal error occurred while processing the request. Please try again later."),
        (501, "An internal error occurred while processing the request. Please try again later."),
        (502, "The service received an invalid response. Please try again later."),
        (503, "The service is temporarily unavailable. Please try again later."),
        (504, "The request timed out. Please try again later."),
    ],
)
def test_status_table_and_unknown_fallback(status, expected_message):
    assert fixed_error_message(error(status)) == expected_message
    assert fixed_error_message(error(499)) == (
        "The request could not be processed. Check the request and try again."
    )


def test_local_auth_and_access_messages_are_the_only_client_specific_ones():
    assert fixed_error_message(error(401, origin=ErrorOrigin.CLIENT)) == (
        "Authentication failed. Provide a valid API key."
    )
    assert fixed_error_message(error(403, origin=ErrorOrigin.CLIENT)) == (
        "Access denied. You do not have permission to perform this request."
    )


@pytest.mark.parametrize("protocol", list(ModelApiProtocol))
def test_protocol_payloads_have_only_the_contract_fields(protocol):
    body = render_error(error(404), protocol).body
    payload = json.loads(body)
    if protocol == ModelApiProtocol.OPENAI:
        assert payload == {
            "error": {
                "message": "The requested resource is unavailable.",
                "type": "not_found_error",
                "code": 404,
            }
        }
    elif protocol == ModelApiProtocol.CLAUDE:
        assert payload == {
            "type": "error",
            "error": {
                "type": "not_found_error",
                "message": "The requested resource is unavailable.",
            },
        }
    else:
        assert payload == {
            "error": {
                "code": 404,
                "message": "The requested resource is unavailable.",
                "status": "NOT_FOUND",
            }
        }


def test_gemini_status_uses_resource_exhausted_for_402_and_argument_for_unknown_4xx():
    payment = json.loads(render_error(error(402), "gemini").body)
    unknown = json.loads(render_error(error(409), "gemini").body)
    assert payment["error"]["status"] == "RESOURCE_EXHAUSTED"
    assert unknown["error"]["status"] == "INVALID_ARGUMENT"


def test_timeout_and_bad_format_are_typed_status_overrides():
    assert error(500, kind=ErrorKind.TIMEOUT).status == 504
    assert error(500, kind=ErrorKind.BAD_FORMAT).status == 502
    assert error_from_http_status(302).status == 502


@pytest.mark.parametrize("bad_status", [True, "404", None, 399, 600])
def test_status_descriptor_rejects_invalid_status_values(bad_status):
    with pytest.raises((TypeError, ValueError)):
        ModelApiError(ErrorOrigin.UPSTREAM, ErrorKind.HTTP, bad_status)


def test_direct_descriptor_applies_typed_status_overrides():
    assert ModelApiError(ErrorOrigin.UPSTREAM, ErrorKind.TIMEOUT, 200).status == 504
    assert ModelApiError(ErrorOrigin.UPSTREAM, ErrorKind.BAD_FORMAT, 399).status == 502
    with pytest.raises((TypeError, ValueError)):
        ModelApiError(ErrorOrigin.UPSTREAM, ErrorKind.HTTP, 500, retry_after=-1)
    with pytest.raises(TypeError):
        ModelApiError(ErrorOrigin.UPSTREAM, ErrorKind.HTTP, 500, retry_after=True)


@pytest.mark.parametrize(
    "status,protocol,expected_type",
    [
        (402, "openai", "server_error"),
        (408, "openai", "timeout_error"),
        (405, "openai", "invalid_request_error"),
        (402, "claude", "api_error"),
        (408, "claude", "api_error"),
        (405, "claude", "invalid_request_error"),
    ],
)
def test_v3_type_mapping_keeps_special_statuses_out_of_generic_4xx(protocol, status, expected_type):
    payload = json.loads(render_error(error(status), protocol).body)
    assert payload["error"]["type"] == expected_type


@pytest.mark.parametrize(
    "status,origin,expected_type",
    [
        (401, ErrorOrigin.CLIENT, "authentication_error"),
        (401, ErrorOrigin.UPSTREAM, "api_error"),
        (403, ErrorOrigin.CLIENT, "permission_error"),
        (403, ErrorOrigin.UPSTREAM, "api_error"),
        (404, ErrorOrigin.UPSTREAM, "not_found_error"),
        (413, ErrorOrigin.UPSTREAM, "invalid_request_error"),
        (422, ErrorOrigin.UPSTREAM, "invalid_request_error"),
        (429, ErrorOrigin.UPSTREAM, "rate_limit_error"),
        (500, ErrorOrigin.LOCAL, "api_error"),
        (502, ErrorOrigin.UPSTREAM, "api_error"),
        (503, ErrorOrigin.UPSTREAM, "overloaded_error"),
        (504, ErrorOrigin.UPSTREAM, "api_error"),
    ],
)
def test_full_claude_status_mapping(status, origin, expected_type):
    payload = json.loads(render_error(error(status, origin=origin), "claude").body)
    assert payload["error"]["type"] == expected_type


@pytest.mark.parametrize("value", [True, "404", None, 200, 399, 600])
def test_http200_error_code_validation_falls_back_to_bad_format(value):
    classified = error_from_http_status(value)
    assert classified.status == 502
    assert classified.kind == ErrorKind.BAD_FORMAT


@pytest.mark.parametrize(
    "status,origin,expected",
    [
        (401, ErrorOrigin.CLIENT, ("authentication_error", "UNAUTHENTICATED")),
        (401, ErrorOrigin.UPSTREAM, ("server_error", "UNAUTHENTICATED")),
        (403, ErrorOrigin.CLIENT, ("permission_error", "PERMISSION_DENIED")),
        (403, ErrorOrigin.UPSTREAM, ("server_error", "PERMISSION_DENIED")),
        (408, ErrorOrigin.UPSTREAM, ("timeout_error", "DEADLINE_EXCEEDED")),
        (413, ErrorOrigin.UPSTREAM, ("invalid_request_error", "INVALID_ARGUMENT")),
        (422, ErrorOrigin.UPSTREAM, ("invalid_request_error", "INVALID_ARGUMENT")),
        (429, ErrorOrigin.UPSTREAM, ("rate_limit_error", "RESOURCE_EXHAUSTED")),
        (500, ErrorOrigin.LOCAL, ("server_error", "INTERNAL")),
        (503, ErrorOrigin.UPSTREAM, ("service_unavailable_error", "UNAVAILABLE")),
        (504, ErrorOrigin.UPSTREAM, ("timeout_error", "DEADLINE_EXCEEDED")),
    ],
)
def test_full_openai_and_gemini_status_mapping(status, origin, expected):
    openai = json.loads(render_error(error(status, origin=origin), "openai").body)
    gemini = json.loads(render_error(error(status, origin=origin), "gemini").body)
    assert openai["error"]["type"] == expected[0]
    assert gemini["error"]["status"] == expected[1]


@pytest.mark.parametrize("protocol,expected", [
    ("openai", b"data: [DONE]\n\n"),
    ("claude", b"event: error\ndata: "),
    ("gemini", b"data: "),
])
def test_all_protocol_stream_error_terminal_frames(protocol, expected):
    event = render_error_event(error(500), protocol)
    assert expected in event
    if protocol in ("claude", "gemini"):
        assert b"[DONE]" not in event


def test_renderer_does_not_accept_or_copy_raw_headers_and_uses_private_marker():
    response = render_error(
        make_model_api_error(
            origin=ErrorOrigin.CLIENT,
            kind=ErrorKind.HTTP,
            status=401,
            retry_after=7,
        ),
        "openai",
    )
    assert response.headers["www-authenticate"] == "Bearer"
    assert response.headers["retry-after"] == "7"
    assert "x-upstream-secret" not in response.headers
    assert "MODEL_SENTINEL" not in response.body.decode()


@pytest.mark.asyncio
async def test_stream_adapter_emits_one_fixed_error_event_and_records_once():
    calls = []

    async def recorder(request, success):
        calls.append(success)

    async def source():
        yield b"data: {\"ok\":true}\n\n"
        raise RuntimeError("MODEL_SENTINEL raw upstream response")

    response = StreamingResponse(source())
    request = Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/stream",
            "headers": [],
            "query_string": b"",
            "scheme": "http",
            "server": ("test", 80),
            "client": ("test", 1),
            "root_path": "",
        }
    )
    activate_logical_request_recording(request, recorder)
    await protect_streaming_response(response, "openai", request=request, recorder=recorder)
    chunks = [chunk async for chunk in response.body_iterator]
    assert chunks[0] == b'data: {"ok":true}\n\n'
    assert len(chunks) == 2
    error_event, done_event = chunks[1].split(b"\n\ndata: [DONE]\n\n")
    payload = json.loads(error_event.removeprefix(b"data: "))
    assert payload["error"]["code"] == 500
    assert done_event == b""
    assert "MODEL_SENTINEL" not in chunks[1].decode()
    assert calls == [False]


@pytest.mark.asyncio
async def test_stream_adapter_records_success_once_and_closes_source():
    calls = []
    closed = []

    async def recorder(request, success):
        calls.append(success)

    async def source():
        try:
            yield b"ok"
        finally:
            closed.append(True)

    response = StreamingResponse(source())
    request = Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/stream",
            "headers": [],
            "query_string": b"",
            "scheme": "http",
            "server": ("test", 80),
            "client": ("test", 1),
            "root_path": "",
        }
    )
    activate_logical_request_recording(request, recorder)
    await protect_streaming_response(response, "gemini", request=request, recorder=recorder)
    assert [chunk async for chunk in response.body_iterator] == [b"ok"]
    assert calls == [True]
    assert closed == [True]


@pytest.mark.asyncio
async def test_stream_adapter_does_not_convert_cancellation_or_generatorexit():
    async def cancelled():
        raise asyncio.CancelledError()
        yield b"unreachable"

    async def exited():
        raise GeneratorExit()
        yield b"unreachable"

    for source in (cancelled(), exited()):
        response = StreamingResponse(source)
        await protect_streaming_response(response, "claude")
        with pytest.raises((asyncio.CancelledError, GeneratorExit)):
            async for _ in response.body_iterator:
                pass


def test_protected_route_catches_validation_and_http_errors_without_echo():
    app = FastAPI()
    app.router.route_class = make_protected_model_api_route_class("openai")

    @app.post("/validation")
    async def validation(value: int = Body(...)):
        return {"value": value}

    @app.get("/http")
    async def http_error():
        raise HTTPException(status_code=403, detail="MODEL_SENTINEL")

    @app.get("/direct")
    async def direct():
        return JSONResponse(
            status_code=401,
            content={"message": "MODEL_SENTINEL"},
            headers={"X-Upstream-Secret": "MODEL_SENTINEL"},
        )

    with TestClient(app) as client:
        validation_response = client.post("/validation", json="MODEL_SENTINEL")
        http_response = client.get("/http")
        direct_response = client.get("/direct")

    assert validation_response.status_code == 422
    assert "MODEL_SENTINEL" not in validation_response.text
    assert http_response.status_code == 403
    assert http_response.json()["error"]["type"] == "server_error"
    assert "MODEL_SENTINEL" not in http_response.text
    assert direct_response.status_code == 401
    assert direct_response.json()["error"]["type"] == "server_error"
    assert "MODEL_SENTINEL" not in direct_response.text
    assert "x-upstream-secret" not in direct_response.headers


def test_typed_local_auth_is_explicit_and_response_attachment_is_private():
    app = FastAPI()
    app.router.route_class = make_protected_model_api_route_class("openai")

    @app.get("/local")
    async def local():
        raise ModelApiErrorException(error(401, origin=ErrorOrigin.CLIENT))

    @app.get("/attached")
    async def attached():
        return attach_model_api_error(
            JSONResponse(status_code=503, content={"raw": "MODEL_SENTINEL"}),
            error(503, origin=ErrorOrigin.LOCAL),
        )

    with TestClient(app) as client:
        local_response = client.get("/local")
        attached_response = client.get("/attached")

    assert local_response.status_code == 401
    assert local_response.json()["error"]["type"] == "authentication_error"
    assert attached_response.status_code == 503
    assert attached_response.json()["error"]["type"] == "service_unavailable_error"
    assert "MODEL_SENTINEL" not in attached_response.text


def test_direct_400_and_3xx_responses_are_fixed_and_location_is_dropped():
    app = FastAPI()
    app.router.route_class = make_protected_model_api_route_class("gemini")

    @app.get("/bad")
    async def bad():
        return JSONResponse(status_code=400, content={"detail": "MODEL_SENTINEL"})

    @app.get("/redirect")
    async def redirect():
        return JSONResponse(
            status_code=302,
            content={"detail": "MODEL_SENTINEL"},
            headers={"Location": "https://secret.invalid/MODEL_SENTINEL"},
        )

    with TestClient(app) as client:
        bad_response = client.get("/bad")
        redirect_response = client.get("/redirect", follow_redirects=False)

    assert bad_response.status_code == 400
    assert bad_response.json()["error"]["status"] == "INVALID_ARGUMENT"
    assert redirect_response.status_code == 502
    assert "location" not in redirect_response.headers
    assert "MODEL_SENTINEL" not in redirect_response.text


@pytest.mark.asyncio
async def test_recorder_is_request_scoped_idempotent_and_failures_do_not_change_result():
    calls = []
    request = Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/record",
            "headers": [],
            "query_string": b"",
            "scheme": "http",
            "server": ("test", 80),
            "client": ("test", 1),
            "root_path": "",
        }
    )

    async def recorder(request, success):
        calls.append(success)
        raise RuntimeError("MODEL_SENTINEL")

    activate_logical_request_recording(request, recorder)
    await record_logical_request_once(request, True)
    await record_logical_request_once(request, False)
    assert calls == [True]


@pytest.mark.asyncio
async def test_recorder_requires_explicit_activation_before_marking_request():
    calls = []
    request = Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/record",
            "headers": [],
            "query_string": b"",
            "scheme": "http",
            "server": ("test", 80),
            "client": ("test", 1),
            "root_path": "",
        }
    )

    async def recorder(request, success):
        calls.append(success)

    await record_logical_request_once(request, True, recorder=recorder)
    assert calls == []
    activate_logical_request_recording(request, recorder)
    await record_logical_request_once(request, False)
    assert calls == [False]


def test_route_callback_requires_activation_and_recorder_failure_is_isolated():
    calls = []

    async def recorder(request, success):
        calls.append(success)
        if success:
            raise RuntimeError("MODEL_SENTINEL")

    app = FastAPI()
    app.router.route_class = make_protected_model_api_route_class("openai", recorder=recorder)

    @app.get("/active")
    async def active(request: Request):
        activate_logical_request_recording(request)
        return {"ok": True}

    @app.get("/inactive")
    async def inactive():
        return {"ok": True}

    with TestClient(app) as client:
        active_response = client.get("/active")
        inactive_response = client.get("/inactive")

    assert active_response.status_code == 200
    assert active_response.json() == {"ok": True}
    assert inactive_response.status_code == 200
    assert inactive_response.json() == {"ok": True}
    assert calls == [True]


def test_replaced_stream_response_closes_iterator_and_runs_background():
    closed = []
    background_ran = []

    class EmptyIterator:
        def __aiter__(self):
            return self

        async def __anext__(self):
            raise StopAsyncIteration

        async def aclose(self):
            closed.append(True)

    async def background():
        background_ran.append(True)

    app = FastAPI()
    app.router.route_class = make_protected_model_api_route_class("gemini")

    @app.get("/upstream")
    async def upstream():
        return StreamingResponse(
            EmptyIterator(),
            status_code=503,
            background=BackgroundTask(background),
        )

    with TestClient(app) as client:
        response = client.get("/upstream")

    assert response.status_code == 503
    assert response.json()["error"]["status"] == "UNAVAILABLE"
    assert closed == [True]
    assert background_ran == [True]


def test_import_is_side_effect_free_and_unconfigured_route_fails_only_if_used():
    assert ProtectedModelApiRoute._protocol is None
    assert ModelApiError.__dataclass_params__.frozen is True
