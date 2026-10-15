# Credential read/export endpoints — verified public source excerpts

Static public source evidence only; no endpoint invocation, credential content, session/grant state or private storage access. Generated 2026-10-14T16:28:17.849139+00:00.

Source: `src/panel/creds.py`; SHA256 `2f6056f3d802776809a54eb379b691d8800cdc455f442c599d8fb90977dc7ec8`. Line ranges below refer to this exact source snapshot. This document contains selected public code statements, not the full source.

| Operation | Actual method/path | Mode/body | Response and boundaries |
| --- | --- | --- | --- |
| Single export | GET `/creds/download/{filename}` | `mode` query; no body | JSON Blob, `application/json`, attachment `Content-Disposition`; request filename is an encoded single path segment. |
| All export | GET `/creds/download-all` | `mode` query; no body or selected list | ZIP Blob, `application/zip`, attachment header. No selected100 cardinality limit applies to this route; do not route it through download-selected. |
| Detail read | GET `/creds/detail/{filename}` | `mode` query; no body | Matching basename plus full credential JSON `content`; typed outer metadata only. Future caller must confirm each opening and clear plaintext on close/channel/session change; never cache or log it. No server per-open confirmation parameter exists. |
| Fetch one email | POST `/creds/fetch-email/{filename}` | `mode` query; no body/force | HTTP200 `{filename,user_email:string,message}` or structured HTTP400 `{filename,user_email:null,message}`. Cache-first action may refresh upstream data; no automatic invocation/replay. Drop raw message/error text in adapters. |

The complete all-download helper was statically inspected: its arguments are only mode, and it enumerates all credentials for that mode; it does not call the selected-list normalizer or assert a selected100 limit. Full content is intentionally delivered only by an explicit export/detail call. This evidence authorizes no live call.

## Existing router prefix

`src/panel/creds.py:77–77`

```python
router = APIRouter(prefix="/creds", tags=["credentials"])
```

## download_cred_file route/signature

`src/panel/creds.py:1699–1704`

```python
@router.get("/download/{filename}")
async def download_cred_file(
    filename: str,
    token: str = Depends(verify_panel_token),
    mode: str = "geminicli"
):
```

## Single download JSON/body/header return

`src/panel/creds.py:1725–1729`

```python
        return Response(
            content=content,
            media_type="application/json",
            headers={"Content-Disposition": f"attachment; filename={filename}"},
        )
```

## download_all_creds route/signature

`src/panel/creds.py:1783–1787`

```python
@router.get("/download-all")
async def download_all_creds(
    token: str = Depends(verify_panel_token),
    mode: str = "geminicli"
):
```

## All-download helper signature and archive selection

`src/panel/creds.py:739–743`

```python
async def download_all_creds_common(mode: str = "geminicli") -> Response:
    """打包下载所有凭证文件的通用函数"""
    mode = validate_mode(mode)
    zip_filename = "antigravity_credentials.zip" if mode == "antigravity" else "credentials.zip"

```

## All-download enumerates credentials, not a selected list

`src/panel/creds.py:745–752`

```python
    credential_filenames = await storage_adapter.list_credentials(mode=mode)

    if not credential_filenames:
        raise HTTPException(status_code=404, detail=f"没有找到 {mode} 凭证文件")

    log.info(f"开始打包 {len(credential_filenames)} 个 {mode} 凭证文件...")

    zip_buffer = io.BytesIO()
```

## All-download ZIP/body/header return

`src/panel/creds.py:774–778`

```python
    return Response(
        content=zip_buffer.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f"attachment; filename={zip_filename}"},
    )
```

## get_cred_detail route/signature

`src/panel/creds.py:1371–1376`

```python
@router.get("/detail/{filename}")
async def get_cred_detail(
    filename: str,
    token: str = Depends(verify_panel_token),
    mode: str = "geminicli"
):
```

## Detail public envelope

`src/panel/creds.py:1408–1420`

```python
        result = {
            "status": file_status,
            "content": credential_data,
            "filename": os.path.basename(filename),
            "backend_type": backend_type,
            "user_email": file_status.get("user_email"),
            "model_cooldowns": file_status.get("model_cooldowns", {}),
        }

        if mode == "geminicli":
            result["preview"] = file_status.get("preview", True)
        else:
            result["enable_credit"] = file_status.get("enable_credit", False)
```

## fetch_user_email route/signature

`src/panel/creds.py:1738–1743`

```python
@router.post("/fetch-email/{filename}")
async def fetch_user_email(
    filename: str,
    token: str = Depends(verify_panel_token),
    mode: str = "geminicli"
):
```

## Fetch-email structured return

`src/panel/creds.py:918–924`

```python
        return JSONResponse(
            content={
                "filename": filename_only,
                "user_email": email,
                "message": "成功获取用户邮箱",
            }
        )
```

## Fetch-email structured return

`src/panel/creds.py:926–933`

```python
        return JSONResponse(
            content={
                "filename": filename_only,
                "user_email": None,
                "message": "无法获取用户邮箱，可能凭证已过期或权限不足",
            },
            status_code=400,
        )
```

