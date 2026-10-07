"""Sampled timings containing only fixed stages, outcomes, row counts and durations."""
import asyncio
import math
import os
import random
import time
from contextlib import contextmanager
from dataclasses import dataclass

from log import log

STAGES = frozenset({"list_request", "list_scan", "list_filter", "list_page",
                    "quota_queue", "quota_oauth", "quota_google", "quota_cas"})


def _sample_rate():
    try:
        value = float(os.environ.get("ANTIGRAVITY_PANEL_TIMING_SAMPLE_RATE", "0.01"))
        return value if math.isfinite(value) and 0 <= value <= 1 else 0.01
    except (ValueError, TypeError):
        return 0.01


@dataclass
class Phase:
    rows: int = 0


@contextmanager
def trace_phase(stage, rows=0):
    if stage not in STAGES:
        raise ValueError("Unknown panel timing stage")
    phase = Phase(rows)
    sampled = random.random() < _sample_rate()
    start = time.monotonic() if sampled else 0
    outcome = "ok"
    try:
        yield phase
    except TimeoutError:
        outcome = "timeout"
        raise
    except asyncio.CancelledError:
        outcome = "cancelled"
        raise
    except BaseException:
        outcome = "error"
        raise
    finally:
        if sampled:
            count = phase.rows if isinstance(phase.rows, int) and not isinstance(phase.rows, bool) else 0
            log.info(f"[AG PANEL TIMING] stage={stage} outcome={outcome} "
                     f"seconds={time.monotonic() - start:.6f} rows={max(0, count)}")
