"""Request-local protection for the panel's reused OAuth/project helpers."""
from contextlib import contextmanager
from contextvars import ContextVar

from log import log as application_log

_context = ContextVar("manual_google", default=None)


@contextmanager
def manual_google_phase(phase, events):
    token = _context.set((phase, events))
    try:
        yield
    finally:
        _context.reset(token)


def observe_response(response):
    context = _context.get()
    if context:
        phase, events = context
        events.append({"phase": phase, "upstream_status": response.status_code,
                       "response_source": "google"})
    return response


def protected_helper_error(message):
    return "Google request failed." if _context.get() else message


class HelperLog:
    """Legacy logs are unchanged outside the explicit manual request context."""
    def __getattr__(self, level):
        original = getattr(application_log, level)

        def emit(message, *args, **kwargs):
            if _context.get():
                return original("[MANUAL GOOGLE] Helper operation completed." if level in ("info", "debug")
                                else "[MANUAL GOOGLE] Helper operation failed.")
            return original(message, *args, **kwargs)
        return emit
