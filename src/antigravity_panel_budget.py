"""Explicit panel and shutdown budgets; never infer proxy settings from the host."""
import math
import os
from dataclasses import dataclass


class PanelBudgetConfigError(ValueError):
    pass


def _number(name, *, unbounded=False):
    value = os.environ.get(name)
    if value is None:
        return None
    value = value.strip()
    if unbounded and value == "unbounded":
        return math.inf
    try:
        result = float(value)
    except (ValueError, TypeError):
        raise PanelBudgetConfigError(name) from None
    if not math.isfinite(result) or result <= 0:
        raise PanelBudgetConfigError(name)
    return result


@dataclass(frozen=True)
class PanelBudgets:
    T: float | None
    L: float | None
    S: float | None

    def work(self, count=1):
        if self.T is not None and self.T <= 10:
            raise PanelBudgetConfigError("ANTIGRAVITY_PANEL_CHAIN_TIMEOUT_SECONDS")
        seconds = 50.0 * max(1, math.ceil(count / 10))
        if count > 10 and self.L is not None:
            seconds = min(seconds, self.L)
        if self.T is not None:
            seconds = min(seconds, self.T - 10)
        return seconds

    def shutdown(self):
        if self.S is None:
            return 5.0
        return max(0.0, min(30.0, self.S - 5))


def load_panel_budgets():
    return PanelBudgets(
        _number("ANTIGRAVITY_PANEL_CHAIN_TIMEOUT_SECONDS", unbounded=True),
        _number("ANTIGRAVITY_LEGACY_BATCH_WORK_TIMEOUT_SECONDS"),
        _number("ANTIGRAVITY_SHUTDOWN_GRACE_SECONDS", unbounded=True),
    )


def panel_list_budget():
    config = PanelBudgets(_number("ANTIGRAVITY_PANEL_CHAIN_TIMEOUT_SECONDS", unbounded=True), None, None)
    if config.T is not None and config.T <= 10:
        raise PanelBudgetConfigError("ANTIGRAVITY_PANEL_CHAIN_TIMEOUT_SECONDS")
    return min(15.0, config.T - 10) if config.T is not None else 15.0


def panel_work_budget(count=1):
    return PanelBudgets(
        _number("ANTIGRAVITY_PANEL_CHAIN_TIMEOUT_SECONDS", unbounded=True),
        _number("ANTIGRAVITY_LEGACY_BATCH_WORK_TIMEOUT_SECONDS"), None).work(count)


def shutdown_budgets():
    return PanelBudgets(None, None, _number("ANTIGRAVITY_SHUTDOWN_GRACE_SECONDS", unbounded=True))
