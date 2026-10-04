"""Request projections contain parameter structure and no message payloads."""

import copy
import pytest

from src.model_routing.projection import generation_parameters, project_request
from src.model_routing.types import FeatureSnapshot, ModelApiProtocol, thaw


def project(protocol, payload):
    return project_request("geminicli", protocol, "public-alpha", payload, FeatureSnapshot())


@pytest.mark.parametrize("value,kind", [(None,"null"),(False,"boolean"),(0,"number"),("", "string"),([],"array"),({},"object")])
def test_presence_type_and_zero_false_are_distinct(value, kind):
    output = project("openai", {"max_completion_tokens": value})
    assert output.fields["max_completion_tokens"]["present"]
    assert output.fields["max_completion_tokens"]["type"] == kind
    assert not output.fields["max_tokens"]["present"]


def test_no_text_tool_schema_image_signature_or_unknown_nested_values():
    secret = "fixture-body-that-must-not-be-retained"
    raw = {"contents": [{"role":"user","parts":[{"text":secret},{"inlineData":{"data":secret}},
                    {"functionCall":{"args":{"secret":secret}},"thoughtSignature":secret}]}],
           "tools":[{"functionDeclarations":[{"parameters":{"secret":secret}}]}],
           "generationConfig":{"thinkingConfig":{"thinkingBudget":3,"unused":{"body":secret}},
                               "imageConfig":{"aspectRatio":"1:1","unused":secret},
                               "responseSchema":{"body":secret}},
           "thinking":{"type":"enabled","budget_tokens":{"unknown":secret},"unused":secret}}
    saved = copy.deepcopy(raw)
    output = project("gemini", raw)
    assert secret not in repr(thaw(output.fields)) + repr(thaw(output.tools)) + repr(thaw(output.image_context))
    assert output.tools["has_tool_calls"] and output.image_context["has_images"]
    assert raw == saved
    with pytest.raises(TypeError):
        output.fields["generation_config"]["thinkingConfig"]["thinkingBudget"] = 9


@pytest.mark.parametrize("completion,max_tokens,expected", [(None,17,17),(0,17,17),(False,17,17),(23,17,23),("opaque",17,"opaque"),(0,None,None)])
def test_openai_limit_uses_truthiness_not_presence(completion,max_tokens,expected):
    output=project("openai",{"max_completion_tokens":completion,"max_tokens":max_tokens})
    assert generation_parameters(output)["maxOutputTokens"] == expected


@pytest.mark.parametrize("thinking,expected", [(None,None),(False,None),([],None),({"type":"invalid"},None),
    ({"type":"enabled"},{"thinkingBudget":48000,"includeThoughts":True}),
    ({"type":"enabled","budget_tokens":0},{"thinkingBudget":0,"includeThoughts":True}),
    ({"type":"disabled"},{"includeThoughts":False})])
def test_anthropic_thinking_and_default_temperature(thinking,expected):
    params=generation_parameters(project("claude",{"thinking":thinking}))
    assert params.get("thinkingConfig") == expected
    assert params["temperature"] == .4
    if isinstance(thinking,dict) and thinking.get("type")=="enabled":
        assert params["stopSequences"] == []


def test_google_search_empty_value_is_distinct_from_truthy_value():
    assert project("gemini",{"tools":[{"googleSearch":{}}]}).tools["google_search"]
    assert not project("gemini",{"tools":[{"googleSearch":{}}]}).tools["google_search_truthy"]
    assert project("gemini",{"tools":[{"googleSearch":{"enabled":True}}]}).tools["google_search_truthy"]


def test_unconsumed_openai_thinking_generation_and_reasoning_do_not_become_config():
    params=generation_parameters(project("openai",{"thinking":{"type":"enabled"},"reasoning_effort":"high",
                                                  "generationConfig":{"thinkingConfig":{"thinkingBudget":5}}}))
    assert params == {}


def test_stop_lists_and_null_and_false_preserved():
    assert generation_parameters(project("openai",{"stop":["one","two"]}))["stopSequences"] == ["one","two"]
    assert generation_parameters(project("openai",{"stop":None}))["stopSequences"] is None
    assert generation_parameters(project("openai",{"stop":False}))["stopSequences"] is False
    assert generation_parameters(project("claude",{"thinking":{"type":"enabled"},"stop_sequences":["one"]}))["stopSequences"][-1]=="one"
