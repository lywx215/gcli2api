from src.converter.antigravity_fix import (
    _ensure_empty_tool_schema_for_claude,
    _ensure_tool_call_ids,
    _normalize_antigravity_request,
    prepare_image_generation_request,
)


def test_antigravity_claude_tools_keep_schema_in_parameters_json_schema():
    tools = [
        {
            "functionDeclarations": [
                {
                    "name": "test_tool",
                    "description": "A test tool.",
                    "parameters": {
                        "type": "object",
                        "properties": {"value": {"type": "string"}},
                    },
                }
            ]
        }
    ]

    result = _ensure_empty_tool_schema_for_claude(tools, "claude-opus-4-6-thinking", "antigravity")
    declaration = result[0]["functionDeclarations"][0]

    assert declaration["parametersJsonSchema"]["type"] == "object"
    assert "parameters" not in declaration


def test_existing_tool_call_id_is_reused_by_response():
    contents = [
        {"role": "model", "parts": [{
            "functionCall": {"id": "toolu_existing", "name": "lookup", "args": {}}
        }]},
        {"role": "user", "parts": [{
            "functionResponse": {"name": "lookup", "response": {"ok": True}}
        }]},
    ]

    result = _ensure_tool_call_ids(contents, "claude-sonnet-4-6")

    assert result[1]["parts"][0]["functionResponse"]["id"] == "toolu_existing"


def test_client_image_config_has_priority_over_size_and_model_suffix():
    result = prepare_image_generation_request(
        {
            "model": "gemini-3.1-flash-image-4k-16x9",
            "size": "1024x1024",
            "generationConfig": {
                "imageConfig": {"imageSize": "2K", "aspectRatio": "3:4"}
            },
        },
        "gemini-3.1-flash-image-4k-16x9",
    )

    assert result["generationConfig"]["imageConfig"] == {
        "imageSize": "2K",
        "aspectRatio": "3:4",
    }


def test_antigravity_gemini_aliases_keep_fork_model_mapping():
    generation_config = {"thinkingConfig": {"thinkingLevel": "HIGH"}}

    mapped = _normalize_antigravity_request(
        {}, "gemini-3.5-flash", generation_config, True
    )

    assert mapped == "gemini-3.5-flash-high"
    assert generation_config["thinkingConfig"] == {"includeThoughts": True}
