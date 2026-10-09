"""Offline browser checks for the Antigravity credential panel.

Run: python test_panel_visual.py [--browser /path/to/chrome]
All requests are intercepted; fixtures and authentication tokens are synthetic.
Screenshots and measurements go to the ignored .cache/credential-panel-ui folder.
"""
import argparse
import json
import os
from pathlib import Path
import time
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent
OUTPUT = ROOT / ".cache" / "credential-panel-ui"
CAPS = ["antigravity.model_access.family_filter", "antigravity.cooldown.group_filter", "antigravity.credentials.search", "antigravity.credentials.auto_email"]
NOW = int(time.time())
LONG_NAME = "1621_" + "synthetic_account_" * 26 + "at_example_invalid.json"
LONG_EMAIL = "synthetic_" * 30 + "@example.invalid"
ITEMS = [
    {"filename": LONG_NAME, "user_email": LONG_EMAIL, "remark": "合成数据 · 长文件名与邮箱", "error_codes": [429], "disabled": False,
     "tier": "free", "quota_groups": {"gemini-shared": {"restricted": True, "blockedUnknown": True, "cooldownUntil": NOW + 3650}, "claude-gpt-shared": {"restricted": True, "blockedUnknown": True}},
     "model_access_families": {"claude-opus-5-5": {"state": "unavailable", "checked_at": NOW}, "claude-opus-4-6": {"state": "supported", "checked_at": NOW}}, "cycle_stats": {"pro": 2, "flash": 3, "other": 6, "total": 11}, "last_cycle_stats": {"total": 8, "flash": 8}},
    {"filename": "1814_synthetic_pending_at_example_invalid.json", "email_enrichment_status": "running", "tier": "free", "disabled": True, "error_codes": [],
     "quota_groups": {"gemini-shared": {"restricted": False}, "claude-gpt-shared": {"restricted": False}}},
    {"filename": "1840_synthetic_failed_at_example_invalid.json", "email_enrichment_status": "failed", "tier": "pro", "disabled": True, "error_codes": [403],
     "quota_groups": {"gemini-shared": {"restricted": False}, "claude-gpt-shared": {"restricted": False}}},
]
STATUS = {"items": ITEMS, "total": len(ITEMS), "has_more": False, "panel_capabilities": CAPS,
          "stats": {"total": 3, "normal": 1, "disabled": 2, "quota_restricted": 1, "quota_unrestricted": 2, "quota_blocked_unknown": 1, "quota_state_invalid": 0},
          "model_access_summary": {"total": 3, "family_counts": {"claude-opus-5-5": {"supported": 0, "unavailable": 1, "unknown": 2, "total": 3}}}}

MEASURE = r"""() => {
 const panel = document.getElementById('antigravity-manageTab');
 const all = selector => [...panel.querySelectorAll(selector)];
 const visible = element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden';
 const rows = all('.status-badge,.error-codes,.cooldown-badge,[data-model-access-badges] > span,.cred-actions button,.ag-search-row button')
   .filter(visible).filter(element => !element.closest('.cred-remark')).map(element => {
     const range = document.createRange(); range.selectNodeContents(element);
     return {text:element.textContent.trim(), lines:new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size,
       nowrap:getComputedStyle(element).whiteSpace, width:element.getBoundingClientRect().width};
   });
 const grouped = all('label[for]').filter(label => /^antigravity(?:Status|ErrorCode|Cooldown|Tier|Remark|PageSize|ModelAccess)/.test(label.htmlFor)).map(label => {
   const input = document.getElementById(label.htmlFor), parent = label.parentElement;
   return {id:label.htmlFor, sameParent:input.parentElement === parent, labelWidth:label.getBoundingClientRect().width,
     controlWidth:input.getBoundingClientRect().width, groupRight:parent.getBoundingClientRect().right};
 });
 const first = panel.querySelector('.cred-card');
 const filename = first.querySelector('.cred-filename'), email = first.querySelector('.cred-email');
 return {viewport:innerWidth, zoom:getComputedStyle(document.documentElement).zoom, scrollWidth:document.documentElement.scrollWidth,
   bodyScrollWidth:document.body.scrollWidth, bodyWidth:document.body.getBoundingClientRect().width,
   containerWidth:document.querySelector('.container').getBoundingClientRect().width,
   containerLeft:document.querySelector('.container').getBoundingClientRect().left,
   containerRight:document.querySelector('.container').getBoundingClientRect().right, rows, grouped,
   filename:{title:filename.title, client:filename.clientWidth, scroll:filename.scrollWidth, overflow:getComputedStyle(filename).textOverflow},
   email:{title:email.title, client:email.clientWidth, scroll:email.scrollWidth, overflow:getComputedStyle(email).textOverflow},
   pending:panel.innerText.includes('邮箱获取中'), retry:panel.innerText.includes('重新获取邮箱'),
   progress:document.getElementById('antigravityEmailEnrichmentProgress').innerText};
}"""


def browser_path(explicit):
    if explicit:
        return explicit
    cache = Path(os.environ.get("LOCALAPPDATA", "")) / "ms-playwright"
    candidates = list(cache.glob("chromium-*/chrome-win*/chrome.exe"))
    return str(sorted(candidates, key=lambda p: int(p.parents[1].name.split('-')[-1]))[-1]) if candidates else None


def run(browser=None):
    OUTPUT.mkdir(parents=True, exist_ok=True)
    measurements = []
    with sync_playwright() as playwright:
        chromium = playwright.chromium.launch(headless=True, executable_path=browser_path(browser))
        for label, template, width, zoom in [
            ("desktop-1920", "control_panel.html", 1920, 1),
            ("desktop-1440", "control_panel.html", 1440, 1),
            ("desktop-1024", "control_panel.html", 1024, 1),
            ("mobile-390", "control_panel_mobile.html", 390, 1),
            ("desktop-1920-zoom125", "control_panel.html", 1920, 1.25),
            ("desktop-390", "control_panel.html", 390, 1),
        ]:
            context = chromium.new_context(viewport={"width": width, "height": 1080}, device_scale_factor=1)
            page = context.new_page()
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))

            def route(request):
                path = urlsplit(request.request.url).path
                if path == "/":
                    request.fulfill(body=(ROOT / "front" / template).read_text(encoding="utf-8"), content_type="text/html; charset=utf-8")
                elif path == "/front/common.js":
                    request.fulfill(body=(ROOT / "front/common.js").read_text(encoding="utf-8"), content_type="application/javascript; charset=utf-8")
                elif path == "/creds/status":
                    request.fulfill(json=STATUS)
                elif path.startswith("/creds/email-enrichment/"):
                    request.fulfill(json={"job_id": "synthetic-job", "sealed": True, "complete": False, "counts": {"running": 1}, "total": 1,
                                          "items": [{"filename": ITEMS[1]["filename"], "status": "running"}]})
                elif path in ("/stats/usage", "/creds/stats-today-by-model"):
                    request.fulfill(json={"totals": {}, "by_family": {}})
                elif path.startswith("/version"):
                    request.fulfill(json={"success": True, "display_version": "synthetic visual QA"})
                else:
                    request.fulfill(status=404, body="offline fixture")

            page.route("**/*", route)
            page.goto("https://synthetic.invalid/#antigravity-manage")
            assert page.locator("#antigravitySearchInput").is_disabled()
            assert page.locator("#antigravitySearchBtn").is_disabled()
            page.evaluate("""zoom => {
                document.documentElement.style.zoom = String(zoom);
                beginPanelSession('synthetic-offline-session');
                document.getElementById('loginSection').classList.add('hidden');
                document.getElementById('mainSection').classList.remove('hidden');
                switchTab('antigravity-manage');
                AppState.emailEnrichment.track({results:[{filename:'1814_synthetic_pending_at_example_invalid.json',status:'success'}],email_enrichment:{job_id:'synthetic-job',accepted:1,skipped:0}},AppState.sessionEpoch);
            }""", zoom)
            page.locator("#antigravityCredsList .cred-card").first.wait_for()
            page.wait_for_timeout(700)
            measurement = page.evaluate(MEASURE)
            measurement["label"] = label
            assert not errors, (label, errors)
            if template == "control_panel.html":
                assert abs(measurement["containerLeft"] - 20 * zoom) <= 1, (label, "left 20px gap", measurement)
                assert abs(width - measurement["containerRight"] - 20 * zoom) <= 1, (label, "right 20px gap", measurement)
            assert measurement["scrollWidth"] <= width + 1, (label, "page overflow", measurement)
            assert measurement["bodyScrollWidth"] <= measurement["bodyWidth"] / zoom + 1, (label, "body overflow", measurement)
            assert all(row["lines"] == 1 and row["nowrap"] == "nowrap" for row in measurement["rows"]), (label, "wrapped row", measurement["rows"])
            assert len(measurement["grouped"]) == 8 and all(group["sameParent"] for group in measurement["grouped"]), (label, "split filter group", measurement["grouped"])
            assert measurement["filename"]["title"] == LONG_NAME and measurement["filename"]["scroll"] > measurement["filename"]["client"], (label, "filename ellipsis", measurement["filename"])
            assert measurement["email"]["title"] == LONG_EMAIL and measurement["email"]["overflow"] == "ellipsis", (label, "email ellipsis", measurement["email"])
            assert measurement["pending"] and measurement["retry"] and "等待/执行 1" in measurement["progress"], (label, "job indicators", measurement)
            # The wide-page class must also reset immediately during a tab transition.
            page.evaluate("switchTab('config')")
            assert not page.evaluate("document.body.classList.contains('antigravity-wide')")
            page.evaluate("switchTab('antigravity-manage')")
            page.wait_for_timeout(700)
            page.screenshot(path=str(OUTPUT / f"{label}.png"), full_page=True)
            page.locator("#antigravity-manageTab").screenshot(path=str(OUTPUT / f"{label}-panel.png"))
            measurements.append(measurement)
            context.close()
        chromium.close()
    (OUTPUT / "measurements.json").write_text(json.dumps(measurements, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"scenarios": len(measurements), "output": str(OUTPUT), "screenshots": [str(OUTPUT / f"{item['label']}.png") for item in measurements]}, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--browser")
    run(parser.parse_args().browser)
