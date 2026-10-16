# UI-001 / UI-002 and dual-screen layout delivery

## Scope and provenance

The new-ui branch had the accepted six-page compact UI baseline as uncommitted frontend changes. This commit includes that frontend baseline as the dependency of UI-001/002 and the unified dual-screen layout. Source implementation was authored by official Antigravity CLI gemini-3.8-flash-high. Codex merged exact delivered files and performed acceptance checks; no new frontend implementation was authored during integration.

Sixteen delivered source/test files were copied into the main UI worktree only after every target matched its frozen baseline SHA-256. No merge conflict or concurrent target change was found. All unrelated tracked files retained their pre-merge hashes. The model-version additions in ResultView.tsx belong to another task: the commit stages the accepted pre-addition frontend version while retaining the newer working file unchanged. Backend changes remain uncommitted.

## Behavior

- Desktop navigation is on the right at 216px with separate explicit Anti/CLI credential links; mobile navigation opens from the right. Logout and the legacy-panel link remain available.
- Credential search stays compact; error/quota grouping preserves draft and explicit-apply behavior and capability checks.
- All six pages share a left-aligned fluid canvas capped at 1720px; import input/status/results use an inner 768px envelope. Data pages use the available width.
- Fixed action docks avoid the desktop sidebar and align their content with the page at 1920px and 2560px. Short viewports use actual 8px adjacent gaps; log terminal flex sizing absorbs toolbar wrapping.

## Integration checks (2026-10-16)

- Main merged frontend: npm run build and npm run check:build passed (18 JS chunks, 2 CSS, six independent pages, no DEV fixtures).
- Independent exact source snapshot intended for commit: npm run build and npm run check:build passed.
- Existing App tests selected for six-page login/navigation/logout, unsaved channel guard, portalled-navigation cleanup and legacy aliases: 4 passed, 10 not selected.
- Existing QuotaCard tests: 9 passed.
- Browser evidence from the delivered snapshot covers six pages at 1920px, candidate short viewports 1440x700/1280x650, 2560px dock alignment, and mobile fallbacks. At 1280x650 final actual page gaps are 8px and log page has no whole-page X/Y overflow. The production build and source equivalence were checked again after merging.

Only the stated checks were run. Historical baseline test failures were previously reproduced before UI-001/002; the full suite is not claimed passing. Physical MacBook Air browser dimensions are unknown, so candidate viewports are simulations, not an on-device claim. Real backend/business end-to-end validation was not run. No production, credential, database or deployment operations were performed. Panel version stays unchanged because no version bump was requested.
