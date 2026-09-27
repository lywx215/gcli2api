"""Gemini CLI model-specific capabilities, separate from Antigravity IDs."""

GEMINI_38_FLASH_MODEL = "gemini-3.8-flash"
GEMINI_38_FLASH_THINKING_LEVELS = ("low", "medium", "high")
GEMINI_38_FLASH_SUFFIXES = (
    "",
    "-search",
    *(f"-{level}" for level in GEMINI_38_FLASH_THINKING_LEVELS),
    *(f"-{level}-search" for level in GEMINI_38_FLASH_THINKING_LEVELS),
)
