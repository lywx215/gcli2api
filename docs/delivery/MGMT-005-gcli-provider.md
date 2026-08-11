# MGMT-005 gcli2api write provider delivery

Status: ready for the manager final compatibility matrix

## Contract and behavior

- Adds idempotent single and batch credential actions for `enable`, `disable`,
  `permanent_disable`, `delete`, and `set_remark`.
- Advertises write capabilities only when the selected storage backend actually
  supports the required operations.
- Requires item idempotency keys, rejects key reuse with a different request, and
  persists pending/completed records for timeout-safe replay.
- Serializes mutations per credential while preserving batch result order and a
  maximum batch size of 100.
- Keeps Legacy routes unchanged and returns only whitelisted credential metadata.

## Verification

- Windows Python 3.12: 83 tests passed, covering single and batch actions,
  idempotent replay, partial failure, conflict and not-found behavior, pending
  recovery, concurrent mutation serialization, capability truthfulness, OpenAPI,
  Legacy registration, and sensitive-field exclusion.
- PR #11 `gcli2api-ci` run 31524233905 passed on Python 3.13.
- PR #11 Docker run 31524233890 built Linux amd64 and arm64 successfully from
  candidate revision `b74d52bc331f23dbd6e4a4e7d49ef8769050d62c`.
- The candidate was build-only: registry login was skipped and `push: false`; no
  image was published and no environment was deployed.
- OpenAPI baseline, sensitive-literal scan, Python compilation, and Git whitespace
  checks passed.

## Limits and rollback

Delete remains a provider capability whose use is separately disabled by default
in the manager. Pending recovery reads the current credential state; an absent
credential after a pending delete is treated as a successful no-change replay.

Rollback is to remove the write capability declarations or revert the MGMT-005
dev7 merge. The read contract from MGMT-004 and all Legacy routes remain usable.
This delivery does not authorize production nodes, real credentials, image
publication, deployment, or macOS verification.
