"""Manual, opt-in Flash transport verification against the real upstream.

Default invocation performs local preflight only. --execute permits at most eight
HTTPS requests (at most one necessary OAuth refresh plus seven generations, no retries). Existing server/database
state is never loaded. Credential JSON is read only and remains in process memory.
Run in a fresh Python process; the audit guard deliberately forbids file writes.
The caller must reserve a cumulative budget across executions and pass the
remaining allowance via --max-http-requests. Each JSON network_summary reports
actual attempted sends; if a process exits without it, charge its full reservation.
The production normalizer currently forces 64000 output tokens. This manual runner
clamps only the final outbound output budget to 512 for bounded live testing; it
verifies transport/protocol behavior, not production handling of max_tokens.
"""
from __future__ import annotations

import argparse
import asyncio
import copy
from contextlib import ExitStack
from datetime import datetime, timedelta, timezone
import hashlib
import json
import logging
import os
from pathlib import Path
import sys
import time
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.dont_write_bytecode = True
MODEL = "gemini-3.8-flash-low"
OUTPUT_TOKENS = 512
PLANNED_GENERATIONS = 7
CASE_TIMEOUT_SECONDS = 90
OAUTH_TIMEOUT_SECONDS = 45
TOKEN_MARGIN_SECONDS = 60
TOKEN_LIFETIME_SECONDS = (
    PLANNED_GENERATIONS * CASE_TIMEOUT_SECONDS + OAUTH_TIMEOUT_SECONDS + TOKEN_MARGIN_SECONDS
)
PROMPT = "Reply with exactly OK."
UPSTREAM = "https://daily-cloudcode-pa.googleapis.com"


class GuardError(RuntimeError):
    pass


def install_guard():
    os.environ["ENABLE_LOG"] = "0"
    logging.disable(logging.CRITICAL)

    def audit(event, args):
        if event == "open":
            mode, flags = args[1], args[2]
            if (isinstance(mode, str) and any(c in mode for c in "wax+")) or (
                isinstance(flags, int) and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND)
            ):
                raise GuardError("filesystem_write_blocked")
        if event in {"sqlite3.connect", "os.remove", "os.rename", "os.mkdir", "subprocess.Popen"}:
            raise GuardError("persistent_state_blocked")
    sys.addaudithook(audit)


def read_credential(directory):
    counts = {"files": 0, "parsed": 0, "usable": 0, "invalid_or_expired": 0}
    selected = fallback = None
    selected_expiry = datetime.min.replace(tzinfo=timezone.utc)
    for path in sorted(directory.glob("*.json")):
        counts["files"] += 1
        try:
            raw = path.read_bytes()
            data = json.loads(raw.decode("utf-8-sig"))
            if not isinstance(data, dict):
                raise ValueError()
            counts["parsed"] += 1
            if fallback is None and all(data.get(k) for k in
                    ("project_id", "refresh_token", "client_id", "client_secret")):
                fallback = (path, hashlib.sha256(raw).digest(), {
                    k: data[k] for k in ("project_id", "refresh_token", "client_id", "client_secret")
                })
                fallback[2].update(enable_credit=False, _refresh_required=True)
            expiry = datetime.fromisoformat(str(data.get("expiry", "")).replace("Z", "+00:00"))
            if expiry.tzinfo is None:
                expiry = expiry.replace(tzinfo=timezone.utc)
            valid = bool(data.get("access_token") or data.get("token")) and bool(data.get("project_id"))
            valid = valid and expiry > datetime.now(timezone.utc) + timedelta(seconds=TOKEN_LIFETIME_SECONDS)
            if not valid:
                raise ValueError()
            counts["usable"] += 1
            if expiry > selected_expiry:
                # Prefer the longest-lived token; retain no refresh secrets when valid.
                selected_expiry = expiry
                selected = (path, hashlib.sha256(raw).digest(), {
                    "access_token": data.get("access_token") or data["token"],
                    "project_id": data["project_id"],
                    "enable_credit": False,
                    "_refresh_required": False,
                })
        except (ValueError, TypeError, KeyError, OSError):
            counts["invalid_or_expired"] += 1
    selected = selected or fallback
    print(json.dumps({"credential_metadata": counts,
                      "refresh_required": bool(selected and selected[2]["_refresh_required"])}), flush=True)
    if selected is None:
        raise GuardError("no_usable_or_refreshable_credential")
    return selected


class MemoryCredential:
    def __init__(self, data):
        self.data = data

    async def get_valid_credential(self, **kwargs):
        if "memory-only" in kwargs.get("excluded_credentials", set()):
            return None
        return "memory-only", dict(self.data)

    async def quota_admit(self, *args, **kwargs):
        return {"revision": 1, "state": "available"}

    async def model_access_generation_result(self, *args, **kwargs):
        return None


class MemoryRoutes:
    async def get_config_fresh(self, key, default):
        return default


async def ignore_state(*args, **kwargs):
    return None


def safe_usage(payload):
    value = payload.get("usageMetadata") or payload.get("usage") or {}
    allowed = {"promptTokenCount", "candidatesTokenCount", "thoughtsTokenCount", "totalTokenCount",
               "cachedContentTokenCount", "prompt_tokens", "completion_tokens", "total_tokens",
               "input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"}
    return {key: item for key, item in value.items() if key in allowed and isinstance(item, int)}


def has_content(payload, protocol):
    if protocol == "gemini":
        return any(isinstance(p, dict) and bool(p.get("text")) and not p.get("thought")
                   for c in payload.get("candidates", []) for p in c.get("content", {}).get("parts", []))
    if protocol == "openai":
        return any(bool(c.get("message", {}).get("content")) for c in payload.get("choices", []))
    return any(p.get("type") == "text" and bool(p.get("text")) for p in payload.get("content", []))


FINISH_REASONS = {"STOP", "MAX_TOKENS", "SAFETY", "RECITATION", "OTHER", "BLOCKLIST",
                  "PROHIBITED_CONTENT", "SPII", "MALFORMED_FUNCTION_CALL", "UNEXPECTED_TOOL_CALL",
                  "stop", "length", "content_filter", "tool_calls", "function_call",
                  "end_turn", "max_tokens", "stop_sequence", "tool_use", "pause_turn", "refusal"}


def finish_reasons(payload):
    values = [payload.get("stop_reason")]
    values.extend(c.get("finishReason") for c in payload.get("candidates", []) if isinstance(c, dict))
    values.extend(c.get("finish_reason") for c in payload.get("choices", []) if isinstance(c, dict))
    return {value for value in values if isinstance(value, str) and value in FINISH_REASONS}


async def run(args, credential):
    calls = []
    try:
        return await _run(args, credential, calls)
    finally:
        print(json.dumps({"network_summary": True, "network_requests": len(calls),
                          "maximum_http_requests": args.max_http_requests}), flush=True)


async def _run(args, credential, calls):
    required_http_requests = PLANNED_GENERATIONS + int(bool(credential.get("_refresh_required")))
    if args.execute and args.max_http_requests < required_http_requests:
        print(json.dumps({"remaining_cases_skipped": True,
                          "skip_reason": "insufficient_complete_run_budget",
                          "required_http_requests": required_http_requests,
                          "available_http_requests": args.max_http_requests}), flush=True)
        return False
    import config
    # This is an isolated CLI process: ignore inherited application configuration.
    for key in (*config.ENV_MAPPINGS, "REDIS_URL"):
        os.environ.pop(key, None)
    import src.api.antigravity  # Load bindings before patching.
    import src.httpx_client as http
    from src.model_routing import prepare_route_context
    from src.models import GeminiRequest, OpenAIChatCompletionRequest, ClaudeRequest
    from src.antigravity_models import get_public_model_metadata
    from src.router.antigravity import gemini, openai, anthropic
    from src.router.model_api_errors import ModelApiErrorException
    from starlette.requests import Request

    metadata = get_public_model_metadata(args.model)
    if metadata is None or "flash" not in metadata.family or "image" in metadata.family:
        raise GuardError("only_catalog_text_flash_allowed")

    settings = {"retry_429_enabled": False, "retry_429_max_retries": 0,
                "smart_429_protection_enabled": False, "auto_ban_enabled": False,
                "auto_ban_error_codes": [], "antigravity_api_url": UPSTREAM,
                "oauth_proxy_url": "https://oauth2.googleapis.com",
                "return_thoughts_to_frontend": False,
                "antigravity_stream2nostream": False, "antigravity_flash_non_stream_mode": "native"}
    async def get_config(key, default=None, env_var=None):
        return settings.get(key, default)

    refreshing = False
    upstream_finishes = set()
    upstream_usage = {}
    budget_guard_applied = False
    case_start = 0
    stopped = False
    async def before_http(request):
        nonlocal stopped
        url = request.url
        generation = (not refreshing and url.host == "daily-cloudcode-pa.googleapis.com"
                      and url.path in {"/v1internal:generateContent", "/v1internal:streamGenerateContent"})
        oauth = refreshing and not calls and url.host == "oauth2.googleapis.com" and url.path == "/token"
        if (not args.execute or stopped or len(calls) >= args.max_http_requests or len(calls) - case_start >= 1
                or request.method != "POST" or url.scheme != "https" or url.port not in (None, 443)
                or url.username or url.password or not (generation or oauth)):
            raise GuardError("network_guard_blocked")
        if generation:
            try:
                body = json.loads(request.content)
                if body["request"]["generationConfig"]["maxOutputTokens"] != OUTPUT_TOKENS:
                    raise GuardError("output_budget_guard_missing")
            except (ValueError, TypeError, KeyError):
                raise GuardError("output_budget_guard_missing") from None
        transport = "oauth" if oauth else ("stream" if "streamGenerateContent" in url.path else "native")
        calls.append({"transport": transport, "status": None})

    async def after_http(response):
        nonlocal stopped
        calls[-1]["status"] = response.status_code
        if response.status_code in (401, 403, 429, 503) or 300 <= response.status_code < 400:
            stopped = True

    original_kwargs = http.http_client.get_client_kwargs
    async def client_kwargs(*a, **kw):
        result = await original_kwargs(*a, **kw)
        result.update(follow_redirects=False, trust_env=False,
                      event_hooks={"request": [before_http], "response": [after_http]})
        return result

    def observe_payload(value):
        # Keep only numeric usage and allowlisted finish enums before validators
        # reject thought-only/empty MAX_TOKENS. Never store or print body text.
        if isinstance(value, dict):
            value = value.get("response", value)
            if isinstance(value, dict):
                upstream_finishes.update(finish_reasons(value))
                upstream_usage.update(safe_usage(value))

    def bounded_payload(payload):
        nonlocal budget_guard_applied
        bounded = copy.deepcopy(payload)
        generation = bounded["request"]["generationConfig"]
        budget_guard_applied |= generation.get("maxOutputTokens") != OUTPUT_TOKENS
        generation["maxOutputTokens"] = OUTPUT_TOKENS
        return bounded

    async def observed_post(*a, **kw):
        kw["json"] = bounded_payload(kw["json"])
        response = await http.post_async(*a, **kw)
        if response.status_code == 200:
            try:
                observe_payload(response.json())
            except (ValueError, TypeError, AttributeError):
                pass
        return response

    async def observed_stream(*a, **kw):
        kw["body"] = bounded_payload(kw["body"])
        iterator = http.stream_post_async(*a, **kw)
        try:
            async for item in iterator:
                try:
                    text = item.decode("utf-8") if isinstance(item, bytes) else item
                    if isinstance(text, str):
                        for line in text.splitlines():
                            if line.startswith("data:") and line[5:].strip() != "[DONE]":
                                observe_payload(json.loads(line[5:]))
                except (ValueError, TypeError, AttributeError):
                    pass
                yield item
        finally:
            await iterator.aclose()

    with ExitStack() as stack:
        for target, replacement in (
            ("config.get_config_value", get_config),
            ("config.AUTO_BAN_ERROR_CODES", []),
            ("config._smart_429_enabled_cache", False),
            ("config._config_cache", settings), ("config._config_initialized", True),
            ("src.api.antigravity.credential_manager", MemoryCredential(credential)),
            ("src.api.antigravity.post_async", observed_post),
            ("src.api.antigravity.stream_post_async", observed_stream),
            ("src.api.antigravity._redis_checked", True), ("src.api.antigravity._redis_client", None),
            ("src.api.antigravity.record_api_call_success", ignore_state),
            ("src.api.antigravity.record_api_call_error", ignore_state),
            ("src.logical_request_stats.record_logical_request", ignore_state),
            ("src.router.stream_passthrough.record_logical_request", ignore_state),
            ("src.router.antigravity.gemini.record_logical_request", ignore_state),
            ("src.router.antigravity.openai.record_logical_request", ignore_state),
            ("src.router.antigravity.anthropic.record_logical_request", ignore_state),
            ("src.model_routing.store._get_adapter", lambda: MemoryRoutes()),
        ):
            stack.enter_context(patch(target, replacement))
        stack.enter_context(patch.object(http.http_client, "get_client_kwargs", client_kwargs))
        # Actual fresh route snapshots, compilers, converters, API and HTTP remain active.
        for protocol in ("gemini", "openai", "anthropic"):
            context = await prepare_route_context("antigravity", ("claude" if protocol == "anthropic" else protocol), args.model, {})
            if not context.resolution.accepted:
                raise GuardError("model_route_rejected")
        if not args.execute:
            print(json.dumps({"preflight": "passed", "network_requests": 0, "model": args.model,
                              "planned_generations": PLANNED_GENERATIONS, "maximum_http_requests": args.max_http_requests,
                              "required_http_requests": required_http_requests,
                              "budget_sufficient": args.max_http_requests >= required_http_requests,
                              "refresh_required": bool(credential.get("_refresh_required"))}), flush=True)
            return True

        if credential.get("_refresh_required"):
            from src.google_oauth_api import Credentials
            # Only this selected credential is refreshed, once, with repo OAuth code.
            refresh_start = time.monotonic()
            refreshing = True
            try:
                creds = Credentials(access_token="", refresh_token=credential["refresh_token"],
                                    client_id=credential["client_id"], client_secret=credential["client_secret"])
                async with asyncio.timeout(OAUTH_TIMEOUT_SECONDS):
                    await creds.refresh()
                if not creds.access_token:
                    raise GuardError("refresh_missing_token")
                if (creds.expires_at is None or
                        creds.expires_at <= datetime.now(timezone.utc) + timedelta(seconds=TOKEN_LIFETIME_SECONDS)):
                    print(json.dumps({"oauth_refresh": "insufficient_lifetime",
                                      "remaining_cases_skipped": True,
                                      "skip_reason": "refresh_lifetime_insufficient",
                                      "required_lifetime_seconds": TOKEN_LIFETIME_SECONDS,
                                      "http": calls[:]}), flush=True)
                    return False
                credential["access_token"] = creds.access_token
                credential["_refresh_required"] = False
                print(json.dumps({"oauth_refresh": "passed", "http": calls[:],
                                  "elapsed_seconds": round(time.monotonic() - refresh_start, 3)}), flush=True)
            except Exception:
                print(json.dumps({"oauth_refresh": "failed", "http": calls[:],
                                  "elapsed_seconds": round(time.monotonic() - refresh_start, 3)}), flush=True)
                return False
            finally:
                refreshing = False
                for key in ("refresh_token", "client_id", "client_secret"):
                    credential.pop(key, None)

        def skip(reason):
            print(json.dumps({"remaining_cases_skipped": True, "skip_reason": reason}), flush=True)
            return False

        async def one(protocol, mode, stream=False):
            nonlocal case_start, budget_guard_applied
            if len(calls) >= args.max_http_requests:
                return skip("http_budget_exhausted")
            case_start = len(calls)
            budget_guard_applied = False
            upstream_finishes.clear()
            upstream_usage.clear()
            settings["antigravity_flash_non_stream_mode"] = mode
            settings["antigravity_stream2nostream"] = mode == "native"
            start = time.monotonic()
            first = len(calls)
            result = {"protocol": protocol, "mode": mode, "client_stream": stream,
                      "global_stream2nostream": settings["antigravity_stream2nostream"],
                      "status": None, "content_present": False, "usage": {}, "finish_reasons": [], "error": None}
            req = Request({"type": "http", "method": "POST", "path": "/manual-live", "headers": []})
            try:
                async with asyncio.timeout(CASE_TIMEOUT_SECONDS):
                    if protocol == "gemini":
                        payload = GeminiRequest(contents=[{"role": "user", "parts": [{"text": PROMPT}]}],
                                                generationConfig={"maxOutputTokens": OUTPUT_TOKENS})
                        handler = gemini.stream_generate_content if stream else gemini.generate_content
                        response = await handler(payload, request=req, model=args.model, api_key="in-memory")
                    elif protocol == "openai":
                        payload = OpenAIChatCompletionRequest(model=args.model, messages=[{"role": "user", "content": PROMPT}],
                                                              max_tokens=OUTPUT_TOKENS, stream=False)
                        response = await openai.chat_completions(payload, request=req, token="in-memory")
                    else:
                        payload = ClaudeRequest(model=args.model, messages=[{"role": "user", "content": PROMPT}], max_tokens=OUTPUT_TOKENS)
                        response = await anthropic.messages(payload, request=req, _token="in-memory")
                    result["status"] = response.status_code
                    if stream and hasattr(response, "body_iterator"):
                        events = 0
                        iterator = response.body_iterator
                        try:
                            async for frame in http.iter_sse_frames(iterator):
                                for line in frame.splitlines():
                                    if line.startswith("data:") and line[5:].strip() != "[DONE]":
                                        item = json.loads(line[5:])
                                        events += 1
                                        if item.get("error"):
                                            result["error"] = "stream_error_event"
                                        result["content_present"] |= has_content(item, protocol)
                                        result["usage"].update(safe_usage(item))
                                        result["finish_reasons"] = sorted(set(result["finish_reasons"]) | finish_reasons(item))
                        finally:
                            await iterator.aclose()
                        result["sse_events"] = events
                    elif response.status_code == 200:
                        item = json.loads(response.body)
                        result["content_present"] = has_content(item, protocol)
                        result["usage"] = safe_usage(item)
                        result["finish_reasons"] = sorted(finish_reasons(item))
                        if item.get("error"):
                            result["error"] = "response_error"
                    else:
                        result["error"] = "http_error"
            except ModelApiErrorException:
                result["error"] = "model_api_error"
            except TimeoutError:
                result["error"] = "timeout"
            except Exception:
                result["error"] = "local_or_transport_error"
            result["output_budget_guard_applied"] = budget_guard_applied
            result["effective_max_output_tokens"] = OUTPUT_TOKENS
            result["finish_reasons"] = sorted(set(result["finish_reasons"]) | upstream_finishes)
            if not result["usage"]:
                result["usage"] = dict(upstream_usage)
            result["elapsed_seconds"] = round(time.monotonic() - start, 3)
            result["http"] = calls[first:]
            expected = "stream" if stream or mode == "stream_collect" else "native"
            result["transport_verified"] = len(result["http"]) == 1 and result["http"][0]["transport"] == expected
            result["upstream_reachable"] = any(call["status"] == 200 for call in result["http"])
            result["inconclusive_output_budget"] = bool(result["upstream_reachable"] and
                not result["content_present"] and set(result["finish_reasons"]) & {"MAX_TOKENS", "length", "max_tokens"})
            if result["inconclusive_output_budget"]:
                result["error"] = "inconclusive_output_budget"
            result["passed"] = bool(result["status"] == 200 and result["content_present"] and not result["error"]
                                    and result["transport_verified"])
            print(json.dumps(result), flush=True)
            return result

        native = await one("gemini", "native")
        if not native:
            return False
        if native["inconclusive_output_budget"]:
            return skip("inconclusive_output_budget")
        if stopped:
            return skip("upstream_stop_status")
        collect = await one("gemini", "stream_collect")
        if not collect:
            return False
        if collect["inconclusive_output_budget"]:
            return skip("inconclusive_output_budget")
        if stopped or not collect["passed"]:
            return skip("upstream_stop_status" if stopped else "collector_case_failed")
        if not native["passed"]:
            return skip("native_failed_after_collect_diagnosis")
        stream = await one("gemini", "native", stream=True)
        if not stream:
            return False
        if stream["inconclusive_output_budget"]:
            return skip("inconclusive_output_budget")
        if stopped or not stream["passed"]:
            return skip("upstream_stop_status" if stopped else "initial_comparison_incomplete")
        for protocol in ("openai", "anthropic"):
            for mode in ("native", "stream_collect"):
                result = await one(protocol, mode)
                if not result:
                    return False
                if result["inconclusive_output_budget"]:
                    return skip("inconclusive_output_budget")
                if not result["passed"] or stopped:
                    return skip("upstream_stop_status" if stopped else "protocol_case_failed")
        return True


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--credentials-dir", type=Path, default=Path("D:/0502/at"))
    parser.add_argument("--model", default=MODEL)
    parser.add_argument("--max-http-requests", type=int, choices=range(1, 9), default=None,
                        help="Caller-reserved remaining cumulative HTTP budget, 1..8")
    parser.add_argument("--execute", action="store_true", help="Explicitly allow real upstream requests")
    args = parser.parse_args(argv)
    if args.execute and args.max_http_requests is None:
        parser.error("--execute requires explicit --max-http-requests from the caller's remaining budget")
    if args.max_http_requests is None:
        args.max_http_requests = 8  # Preflight only; no network authorization.
    return args


def main():
    args = parse_args()
    install_guard()
    selected = None
    ok = False
    try:
        selected = read_credential(args.credentials_dir)
        ok = asyncio.run(run(args, selected[2]))
    except Exception:
        if selected is None:
            print(json.dumps({"network_summary": True, "network_requests": 0,
                              "maximum_http_requests": args.max_http_requests}), flush=True)
        print(json.dumps({"error": "preflight_or_execution_failed"}), flush=True)
    finally:
        unchanged = selected is None or hashlib.sha256(selected[0].read_bytes()).digest() == selected[1]
        print(json.dumps({"completed": ok, "source_credential_unchanged": unchanged,
                          "execution_enabled": args.execute}), flush=True)
    return 0 if ok and unchanged else 1


if __name__ == "__main__":
    raise SystemExit(main())
