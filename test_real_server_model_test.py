from scripts.test_all_base_models import (
    _base_antigravity_models,
    _extract_generated_content,
)


def test_base_antigravity_models_excludes_local_feature_variants():
    payload = {
        "data": [
            {"id": "gemini-3.1-pro-high"},
            {"id": "假流式/gemini-3.1-pro-high"},
            {"id": "流式抗截断/gemini-3.1-pro-high"},
            {"id": "claude-sonnet-4-6"},
            {"id": "claude-sonnet-4-6"},
        ]
    }

    assert _base_antigravity_models(payload) == [
        "gemini-3.1-pro-high",
        "claude-sonnet-4-6",
    ]


def test_extract_generated_content_accepts_text():
    payload = {"choices": [{"message": {"content": "MODEL_TEST_OK"}}]}

    assert _extract_generated_content(payload) == "MODEL_TEST_OK"


def test_extract_generated_content_accepts_multimodal_blocks():
    payload = {
        "choices": [
            {
                "message": {
                    "content": [{"type": "image_url", "image_url": {"url": "data:image/png"}}]
                }
            }
        ]
    }

    assert "image_url" in _extract_generated_content(payload)
