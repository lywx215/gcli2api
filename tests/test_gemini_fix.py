from src.converter.gemini_fix import _ensure_empty_tool_schema_for_claude


def test_antigravity_claude_tools_keep_schema_in_parameters():
    tools = [
        {
            "functionDeclarations": [
                {
                    "name": "test_tool",
                    "description": "A test tool.",
                    "parametersJsonSchema": {
                        "type": "object",
                        "properties": {"value": {"type": "string"}},
                    },
                }
            ]
        }
    ]

    result = _ensure_empty_tool_schema_for_claude(tools, "claude-opus-4-6-thinking", "antigravity")
    declaration = result[0]["functionDeclarations"][0]

    assert declaration["parameters"]["type"] == "object"
    assert "parametersJsonSchema" not in declaration


def test_geminicli_claude_tools_keep_schema_in_parameters():
    tools = [
        {
            "functionDeclarations": [
                {
                    "name": "search",
                    "parameters_json_schema": {
                        "type": "object",
                        "properties": {"query": {"type": "string"}},
                    },
                }
            ]
        }
    ]

    result = _ensure_empty_tool_schema_for_claude(
        tools,
        "claude-sonnet-4-6-thinking",
        "geminicli",
    )
    declaration = result[0]["functionDeclarations"][0]

    assert declaration["parameters"]["properties"]["query"]["type"] == "string"
    assert "parametersJsonSchema" not in declaration
    assert "parameters_json_schema" not in declaration


def test_claude_custom_input_schema_is_preserved():
    tools = [
        {
            "custom": {
                "name": "read_file",
                "description": "Read a file.",
                "input_schema": {
                    "type": "object",
                    "required": ["path"],
                    "properties": {"path": {"type": "string"}},
                },
            }
        }
    ]

    result = _ensure_empty_tool_schema_for_claude(
        tools,
        "claude-opus-4-6-thinking",
        "antigravity",
    )
    declaration = result[0]["functionDeclarations"][0]

    assert declaration["name"] == "read_file"
    assert declaration["description"] == "Read a file."
    assert declaration["parameters"]["required"] == ["path"]
