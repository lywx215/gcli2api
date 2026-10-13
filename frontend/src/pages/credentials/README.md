# Credentials page integration

Only `frontend/src/pages/credentials/**` is owned by this feature. Import the default `CredentialsPage` from `index.tsx` through the root owner's lazy route. Foundation still routes to a placeholder in this branch; the normal app build does not yet include the credentials page chunk.

Foundation source dependencies (cherry-picked locally):

- `86027ac852608ee26954d8d859fbe393559419e7` → local `c59c391`
- `88cfdd6abbcb610b2ad423b401a42108222109a4` → local `8d7765e`
- `1d249899f8849b0511bfb140eee1210e9fe12673` → local `f20cd73`

Backend integration requires the root's credential capability change `4e8f9e401ca464c714f7a32273cca209dd1814b9`. It is intentionally not cherry-picked here. The adapter gates permanent state/filter/action, remark/filter and credit controls on the exact panel capability strings. No backend brand checks exist in the page.

The authenticated page bridge unmounts its entire workspace when logged out and keys it on `sessionEpoch`. This is required even when App keeps page modules mounted: it removes body-portaled Sheets and AlertDialogs, cached reads, selections and pending tasks. Read generations and AbortController separately fence filter changes, reloads and writes. A 501 capability denial is locked out for the current workspace session; temporary 503/504 errors do not downgrade capabilities.

All-matching selection fetches pages of 1000 into an explicit filename Set. Filter/session/capability changes cancel collection. It is not an atomic snapshot. Download/email utilities enforce 100 before request; other bulk operations retain the full set. ZIP result headers and Blob are handled independently. Batch actions parse aggregate counts, not HTTP status alone.

Manual quota/model-test/project verification only run from explicit buttons, and never from opening/focusing the detail Sheet. Batch quota runs sequential groups of ten. Stop prevents later groups; it does not abort/roll back the in-flight group. Missing, duplicate or unexpected result IDs stop later groups as unknown, preserving previously confirmed groups. Upstream success and each state-update result are displayed independently. Details use list summaries and the saved-error endpoint, never the full credential endpoint.

DEV fixtures require both `import.meta.env.DEV` and `VITE_UI_FIXTURES === 'true'`. They never serve as an error fallback. Synthetic preview counts/actions are labeled as simulations. No credential payload is persisted in browser storage.

Validation uses mocked fetch only, including real AuthProvider storage-event and epoch lifecycle, adapter errors, aggregate partial writes, old-response races, quota unknown states, large selection, and batch stopping. Validation passed: 86 page tests plus 66 foundation tests (152 total), TypeScript typecheck, normal production build, a separate production library build of the credentials entry (without modifying shared routes/config), and the existing 29 synthetic Node panel-state regression tests. The shared app build still has placeholder routes; final lazy-route build and responsive browser/keyboard/zoom verification belong to root integration and have not been claimed as completed here. No real backend, OAuth, model, production data or deployment was used.
