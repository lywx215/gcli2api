# SavedPasswords GET endpoint evidence

Static public-source inspection, 2026-10-15. No HTTP request, password read, private-state inspection, test, CLI/model dispatch, or frontend edit was performed. Source root: `C:/Users/lywx2/.codex/worktrees/ui-full-parity/gcli2api`.

This compact document replaces the large backend source/contract context for the one-function adapter request. Before dispatch, stage it unchanged at `docs/ui-redesign/P2_SAVED_PASSWORDS_GET_ENDPOINT_EVIDENCE.md` in that worktree and freeze the current direct dependencies. It is evidence, not implementation or acceptance proof.

## Public route and response

`src/panel/config_routes.py:24,141-143`:

```python
router = APIRouter(prefix="/config", tags=["config"])
@router.get("/get")
async def get_config(token: str = Depends(verify_panel_token), include_secrets: bool = True):
    """获取当前配置；include_secrets=false 时只返回密码配置状态。"""
```

`src/panel/config_routes.py:200-202`:

```python
        current_config["api_password"] = await config.get_api_password()
        current_config["panel_password"] = await config.get_panel_password()
        current_config["password"] = await config.get_server_password()
```

The backend subsequently merges unlocked, nonreserved stored config. These are the endpoint's current effective values; this does not prove a separate stored-only password lookup. The envelope has `config`, `capabilities`, `env_locked`, and `security`; it need not contain `success:true`. True does not require `secret_fields`.

`src/panel/config_routes.py:243-254`:

```python
        if not include_secrets:
            # Derive status after storage merge so it describes the same effective
            # values as the legacy response, without returning password contents.
            response_data["secret_fields"] = {
                key: {"configured": bool(current_config.pop(key, None))}
                for key in ("api_password", "panel_password", "password")
            }
        return JSONResponse(content=response_data, headers={"Cache-Control": "no-store"})

    except Exception as e:
        log.error(f"获取配置失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))
```

The adapter must therefore suppress raw error bodies/details. Do not change the backend, use management endpoints, return management-token status/value, or expose unrelated config.

## Ordinary read and existing save stay unchanged

`frontend/src/api/config.ts:22-27`:

```typescript
export async function readSafeConfig(signal?: AbortSignal): Promise<SafeConfigResponse> {
  const data = await requestJson<unknown>("config/get", {
    method: "GET",
    query: { include_secrets: false },
    signal,
```

`frontend/src/pages/settings/api.ts:85,87-95`:

```typescript
  return readSnapshot(await readSafeConfig(signal));
export type SaveResult={kind:'acknowledged'|'partial'|'unknown'|'rejected'; acknowledged:string[]};
export function readSave(raw:unknown,sent:Config):SaveResult {
  if(!object(raw))return {kind:'unknown',acknowledged:[]};
  if(raw.success===false||raw.error)return {kind:'rejected',acknowledged:[]};
  const saved=object(raw.saved_config)?raw.saved_config:{};
  const keys=Object.keys(sent).filter(key=>same(saved[key],sent[key]));
  return {kind:keys.length===Object.keys(sent).length?'acknowledged':keys.length?'partial':'unknown',acknowledged:keys};
}
export async function saveConfig(patch:Config) {if(fixtureMode)return readSave((await import('./fixtures')).save(patch),patch);return readSave(await requestJson('config/save',{method:'POST',body:{config:patch}}),patch);}
```

The first line is a separate excerpt from getConfig. Snapshot excludes secret fields. The existing save compares exactly the values submitted in this request, including submitted passwords, and returns acknowledged key names only. The new function must not change these contracts.

## Client and session boundary

`frontend/src/api/client.ts:6-9,144-147,158-163,170`:

```typescript
export class ApiError extends Error {
  constructor(public status: number, public payload: unknown, message = `请求未完成（HTTP ${status}）`) {
    super(message); this.name = "ApiError";
  }
}
    const init: RequestInit = { method: options.method ?? "GET", headers, body, signal: controller.signal, credentials: "same-origin", redirect: "error", cache: "no-store" };
    const response = import.meta.env.DEV && import.meta.env.VITE_UI_FIXTURES === "true"
      ? await (await import("@/app/fixtures")).fixtureFetch(url, init)
      : await fetch(url, init);
      throw new ApiError(response.status, payload, authFailed ? "登录已失效，请重新登录。" : undefined);
    }
    const result = kind === "blob" ? { blob: await response.blob(), response } : response.status === 204 ? null : await response.json();
    assertCurrent();
    // Endpoint adapters determine success / partial / error semantics of a 2xx body.
    return result;
export async function requestJson<T>(path: string, options: RequestOptions = {}): Promise<T> { return await request(path, options, "json") as T; }
```

These are separate excerpts. The client resolves node-relative `config/get` against its validated same-origin service base, captures the current session epoch, forwards signal abort, registers session cleanup, and checks epoch/abort before and after transport/body reads. It does not itself check validation status. Do not add mode/scope/force_backend parameters to this shared endpoint. ApiError contains a raw payload: the new function must return only fixed safe errors with null/no payload or cause; preserve abort semantics.

`frontend/src/auth/session.ts:4-8,34-41`:

```typescript
export type SessionSnapshot = { token: string | null; sessionEpoch: number };
export type SessionValidationStatus = "anonymous" | "pending" | "verified" | "unavailable";
export type SessionValidationSnapshot = { sessionEpoch: number; status: SessionValidationStatus };
export function getSessionSnapshot(): SessionSnapshot {
  initSnapshots();
  return snapshot!;
}
export function getSessionValidationSnapshot(): SessionValidationSnapshot {
  initSnapshots();
  return validationSnapshot!;
}
```

Validation status changes replace validationSnapshot with a new object, notify validation listeners, and do not run session cleanup (`session.ts:108-122`). Capture the verified session and validation snapshot at invocation and check they remain current, with a nonnull token, matching epoch and verified status, plus caller signal, before transport and after await/projection. Checking current verified status alone can miss a validation pending/verified cycle. Do not copy a bearer token into new state/cache or return it.

## Narrow adapter contract

Add only `export async function getSavedPasswords(signal: AbortSignal)` in settings/api.ts, with an inferred optional-string object result. No new exported type, module helper, Snapshot edit, caller, component, or test.

Use requestJson with explicit GET `config/get`, `query:{include_secrets:true}`, and signal. Return a fresh object containing only own string-valued `api_password`, `panel_password`, `password` properties; keep an empty string, omit absent/nonstring properties, and reject malformed/negative envelopes with fixed safe errors. Never spread or return raw config/body/errors/cause, cache/persist/log, or put plaintext in a fixture. DEV fixture mode returns a fixed unsupported HTTP 501 error with null payload before any fixtureFetch or live fetch. No fallback.

The future component supplies explicit confirmation for each opening and keeps plaintext locally, clearing it on close/channel/session/validation/unmount. This adapter request neither implements nor claims that component consent/cleanup. No backend change or password mutation is needed.

## SHA-256 of inspected public files

| Path | SHA-256 |
| --- | --- |
| src/panel/config_routes.py | 6f697bd754035923d2c97caaef02a7ddbae06f9032c2da9d421292618f9217ce |
| frontend/src/pages/settings/api.ts | e201f8dc95490ee625ba843c0ebe223bfbc3098d0a195a789c942fe539459eed |
| frontend/src/api/client.ts | ee3d7dfac1775b55032f3c79ed90624d664778cda34c1a20b16d33e062795eb0 |
| frontend/src/auth/session.ts | ece4b8695e6551a40c53caf703d0d57dcb5ddf39d0271b2d37546cf9a627326b |
| frontend/src/api/config.ts | 02f0894b036b3b6d7948abf45397b0f50f3eb0a6209097d8f1da193d9d4a84e0 |

No active 71071 App, Settings index, ManagementToken or credential Statistics source was read or hashed.

