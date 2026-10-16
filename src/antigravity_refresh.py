"""Merge OAuth refresh fields into raw Antigravity uploads, never runtime views."""


def refreshed_credential_data(original, refreshed):
    # Reserved fields describe the selected row, not uploaded credential data.
    result = {key: value for key, value in original.items() if not key.startswith("_quota_")}
    result.update({key: value for key, value in refreshed.items()
                   if value is not None and not key.startswith("_quota_")})
    if "token" in original:
        result["token"] = result.get("access_token") or original["token"]
    return result
