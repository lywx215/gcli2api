---
description: Adding debug-only logs using the debug mode system
---

# Adding Debug Mode Logs

When the user asks to add debug logs (调试日志) or mentions "调试模式下处理 xxx log", follow this pattern:

## How to Add a Debug Log

1. **Import** the `debug_log` function:
   ```python
   from src.api.utils import debug_log
   ```

2. **Use** `debug_log()` instead of `log.debug()` for logs that should only appear in debug mode:
   ```python
   # Normal log (always output based on log level)
   log.info("Server started")

   # Debug mode log (only output when debug_mode=True in config)
   debug_log(f"[STREAM] Received chunk size: {len(chunk)}")
   debug_log(f"[STREAM] Error details: {e}", level="warning")
   ```

3. **Available levels**: `debug`, `info`, `warning`, `error`, `critical`
   - Default level is `debug`
   - All debug_log messages are automatically prefixed with `[DEBUG]`

## When to Use debug_log vs log.xxx

- **Use `debug_log()`**: For detailed diagnostic info that would be too noisy in production
  - Request/response payload dumps
  - Internal state snapshots
  - Retry attempt details
  - Credential selection flow
  - Chunk-level stream processing details

- **Use `log.xxx()`**: For normal operational logs
  - Server start/stop
  - API call success/failure (summary)
  - Configuration changes
  - Error conditions that need attention

## Configuration

- **Config key**: `debug_mode` (boolean, default: `false`)
- **Environment variable**: `DEBUG_MODE=true`
- **Panel**: Toggle in config panel via `/config/get` and `/config/save`
- **Sync cache**: `is_debug_mode()` is zero-overhead (sync, reads memory cache)
- **Hot reload**: Changes take effect immediately after `reload_config()`

## Key Files

- `config.py`: `get_debug_mode()`, `is_debug_mode()`, `_debug_mode_cache`
- `src/api/utils.py`: `debug_log()` function
- `src/panel/config_routes.py`: Panel read/write support
