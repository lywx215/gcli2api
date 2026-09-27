import json

from src.router.model_retirement import (
    BUFFER_OVERFLOW_STATUS_CODE,
    MAX_BUFFERED_EVENT_BYTES,
    RETIREMENT_STATUS_CODE,
    RetirementAction,
    RetirementStream,
    check_non_stream,
    is_model_retirement_notice,
    new_attempt,
)


NOTICE = "Gemini gemini-2.5-pro/preview is no longer available."


def candidate(*parts, index=0, finish_reason=None):
    value = {"index": index, "content": {"role": "model", "parts": list(parts)}}
    if finish_reason is not None:
        value["finishReason"] = finish_reason
    return value


def text_part(text, *, thought=False):
    return {"text": text, **({"thought": True} if thought else {})}


def payload(*candidates, response=False):
    body = {"candidates": list(candidates)}
    return {"response": body} if response else body


def test_non_stream_detects_wrapped_notice_and_does_not_return_raw_text():
    raw = payload(
        candidate(text_part(NOTICE + " Please switch to gemini-2.0-flash.")),
        response=True,
    )

    result = check_non_stream(raw)

    assert result.action is RetirementAction.RETIRED
    assert result.status_code == RETIREMENT_STATUS_CODE
    assert result.events == ()
    assert NOTICE not in repr(result)
    assert is_model_retirement_notice(raw)


def test_notice_is_case_insensitive_and_accepts_the_documented_name_alphabet():
    accepted = [
        "Gemini A is no longer available.",
        "  \tGemini model_2.5/preview+test-(x) is no longer available.",
        "GEMINI Model Name is NO LONGER AVAILABLE.",
    ]

    for notice in accepted:
        assert check_non_stream(payload(candidate(text_part(notice)))).action is RetirementAction.RETIRED


def test_invalid_name_or_leading_whitespace_is_not_a_retirement_notice():
    invalid = [
        "Gemini  is no longer available.",
        "Gemini model:secret is no longer available.",
        " " * 65 + NOTICE,
        "Gemini " + ("x" * 129) + " is no longer available.",
        "Gemini model is no longer available!",
    ]

    for text in invalid:
        result = check_non_stream(payload(candidate(text_part(text))))
        assert result.action is RetirementAction.PASS


def test_notice_must_be_the_first_displayed_text_not_a_later_quote_or_discussion():
    ordinary = [
        "The service says: " + NOTICE,
        '"' + NOTICE + '"',
        "```\n" + NOTICE + "\n```",
        "A model discussion mentions " + NOTICE,
    ]

    for text in ordinary:
        result = check_non_stream(payload(candidate(text_part(text))))
        assert result.action is RetirementAction.PASS
        assert result.events == (payload(candidate(text_part(text))),)


def test_thought_text_is_not_scanned_but_display_text_after_it_is():
    thought_only = payload(candidate(text_part(NOTICE, thought=True)))
    assert check_non_stream(thought_only).action is RetirementAction.PASS

    followed_by_notice = payload(
        candidate(text_part("internal", thought=True), text_part(NOTICE))
    )
    assert check_non_stream(followed_by_notice).action is RetirementAction.RETIRED


def test_tool_or_image_before_text_closes_the_retirement_scanner():
    ordinary = payload(
        candidate(
            {"functionCall": {"name": "lookup", "args": {}}},
            text_part(NOTICE),
        )
    )
    image = payload(candidate({"inlineData": {"mimeType": "image/png", "data": "x"}}))

    assert check_non_stream(ordinary).action is RetirementAction.PASS
    assert check_non_stream(image).action is RetirementAction.PASS


def test_stream_buffers_each_character_and_retires_without_releasing_any_event():
    stream = RetirementStream()
    for position, character in enumerate(NOTICE):
        result = stream.feed(payload(candidate(text_part(character))))
        if position != len(NOTICE) - 1:
            assert result.action is RetirementAction.BUFFER
            assert result.events == ()
        else:
            assert result.action is RetirementAction.RETIRED
            assert result.status_code == RETIREMENT_STATUS_CODE
            assert result.events == ()


def test_stream_releases_an_incomplete_prefix_only_at_eof_in_original_order():
    first = payload(candidate(text_part("Gemini gemini")))
    second = payload(candidate({"usageMetadata": {"totalTokenCount": 3}}))
    stream = RetirementStream()

    assert stream.feed(first).action is RetirementAction.BUFFER
    assert stream.feed(second).action is RetirementAction.BUFFER

    result = stream.finish()
    assert result.action is RetirementAction.PASS
    assert result.events == (first, second)
    assert stream.finish().events == ()


def test_stream_finish_reason_flushes_an_incomplete_prefix_but_complete_notice_wins():
    stream = RetirementStream()
    incomplete = payload(candidate(text_part("Gemini old"), finish_reason="STOP"))
    result = stream.feed(incomplete)
    assert result.action is RetirementAction.PASS
    assert result.events == (incomplete,)

    stream = RetirementStream()
    complete = payload(candidate(text_part(NOTICE), finish_reason="STOP"))
    result = stream.feed(complete)
    assert result.action is RetirementAction.RETIRED
    assert result.events == ()


def test_stream_releases_buffer_when_prefix_is_proven_ordinary_and_keeps_scanning():
    first = payload(candidate(text_part("Gemini gemini")))
    second = payload(candidate(text_part(" model:secret")))
    third = payload(candidate(text_part(" later")))
    stream = RetirementStream()

    assert stream.feed(first).action is RetirementAction.BUFFER
    released = stream.feed(second)
    assert released.action is RetirementAction.PASS
    assert released.events == (first, second)
    assert stream.feed(third).events == (third,)


def test_metadata_and_large_thought_events_pass_before_first_display_text():
    stream = RetirementStream()
    thought = payload(candidate(text_part("t" * 8192, thought=True)))
    metadata = {"usageMetadata": {"grounding": "g" * 8192}}

    assert stream.feed(thought).events == (thought,)
    assert stream.feed(metadata).events == (metadata,)
    assert stream.feed(payload(candidate(text_part(NOTICE)))).action is RetirementAction.RETIRED


def test_pending_event_queue_preserves_mixed_event_order_and_multi_candidate_state():
    first = payload(
        candidate(text_part("normal"), index=0),
        candidate(text_part("Gemini gemini-2.5"), index=1),
    )
    second = payload(
        candidate(text_part("still normal"), index=0),
        candidate(text_part("-pro is no longer available."), index=1),
    )
    stream = RetirementStream()

    assert stream.feed(first).action is RetirementAction.BUFFER
    result = stream.feed(second)
    assert result.action is RetirementAction.RETIRED
    assert result.events == ()


def test_non_text_candidate_is_independent_from_another_pending_candidate():
    first = payload(
        candidate({"functionCall": {"name": "lookup"}}, index=0),
        candidate(text_part("Gemini gemini"), index=1),
    )
    second = payload(
        candidate(text_part(NOTICE), index=0),
        candidate(text_part(": ordinary"), index=1),
    )
    stream = RetirementStream()

    assert stream.feed(first).action is RetirementAction.BUFFER
    # Candidate 0 was already ordinary because its tool call preceded text;
    # candidate 1's later text proves its prefix ordinary and releases both.
    result = stream.feed(second)
    assert result.action is RetirementAction.PASS
    assert result.events == (first, second)


def test_buffer_overflow_is_fixed_502_and_drops_all_buffered_events():
    sentinel = "Gemini secret-model"
    event = payload(candidate(text_part(sentinel)))
    stream = RetirementStream(max_buffered_event_bytes=1)

    result = stream.feed(event)
    assert result.action is RetirementAction.BUFFER_OVERFLOW
    assert result.status_code == BUFFER_OVERFLOW_STATUS_CODE
    assert result.events == ()
    assert sentinel not in repr(result)


def test_buffer_limit_accepts_exact_boundary_then_rejects_the_next_pending_event():
    first = payload(candidate(text_part("Gemini secret")))
    first_size = len(json.dumps(first, ensure_ascii=False, separators=(",", ":")).encode())
    second = {"usageMetadata": {"totalTokenCount": 1}}
    stream = RetirementStream(max_buffered_event_bytes=first_size)

    assert stream.feed(first).action is RetirementAction.BUFFER
    result = stream.feed(second)
    assert result.action is RetirementAction.BUFFER_OVERFLOW
    assert result.status_code == BUFFER_OVERFLOW_STATUS_CODE
    assert result.events == ()
    assert MAX_BUFFERED_EVENT_BYTES > first_size


def test_new_attempt_starts_with_fresh_candidate_state():
    first_attempt = new_attempt()
    assert first_attempt.feed(payload(candidate(text_part("Gemini old")))).action is RetirementAction.BUFFER
    second_attempt = new_attempt()
    result = second_attempt.feed(payload(candidate(text_part("ordinary"))))
    assert result.action is RetirementAction.PASS
    assert result.events


def test_pydantic_like_objects_are_accepted_without_mutation():
    class Part:
        def model_dump(self, **kwargs):
            return {"text": NOTICE}

    class Candidate:
        def model_dump(self, **kwargs):
            return {"index": 0, "content": {"parts": [Part()]}}

    class Response:
        def model_dump(self, **kwargs):
            return {"response": {"candidates": [Candidate()]}}

    assert is_model_retirement_notice(Response())
