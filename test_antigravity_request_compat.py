from src.api import antigravity


async def test_wrap_cli_request_keeps_session_state_and_client_tool_mode():
    antigravity._session_states.clear()
    request = {
        "contents": [{"role": "user", "parts": [{"text": "same prompt"}]}],
        "toolConfig": {"functionCallingConfig": {"mode": "ANY"}},
    }

    first, _ = await antigravity.wrap_cli_request(
        request, "gemini-3.5-flash-low", "project-a", enable_credit=False
    )
    second, _ = await antigravity.wrap_cli_request(
        request, "gemini-3.5-flash-low", "project-a", enable_credit=True
    )

    assert first["request"]["labels"]["trajectory_id"] == second["request"]["labels"]["trajectory_id"]
    assert first["request"]["labels"]["last_step_index"] == "1"
    assert second["request"]["labels"]["last_step_index"] == "2"
    assert first["request"]["toolConfig"]["functionCallingConfig"]["mode"] == "ANY"
    assert "enabledCreditTypes" not in first
    assert second["enabledCreditTypes"] == ["GOOGLE_ONE_AI"]


def test_antigravity_headers_only_forward_trace_allowlist():
    headers = antigravity.build_antigravity_headers(
        "fake-token",
        {
            "Authorization": "untrusted",
            "User-Agent": "untrusted",
            "X-Custom": "untrusted",
            "traceparent": "00-test",
            "x-b3-traceid": "trace-id",
        },
        "gemini-3.1-flash-image",
    )

    assert headers["Authorization"] == "Bearer fake-token"
    assert headers["User-Agent"] == antigravity.ANTIGRAVITY_USER_AGENT
    assert "X-Custom" not in headers
    assert headers["traceparent"] == "00-test"
    assert headers["x-b3-traceid"] == "trace-id"
    assert headers["requestType"] == "image_gen"
