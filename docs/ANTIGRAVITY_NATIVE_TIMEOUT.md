# Antigravity native timeout

The panel setting `antigravity_native_timeout_seconds` defaults to 480 seconds and
accepts only integers from 30 through 3600. `/config/get` advertises capability
`antigravity.native.timeout`; `/config/save` validates the whole input before
writing any configuration. Invalid persisted values read as 480. Existing KV
storage persists the value; no schema changes, no_counterpart_action.

The setting applies to every Antigravity direct non-stream model, including the
native request behind fake streaming. A request freezes its transport selection
and timeout. Saving affects new requests without a restart; in-flight requests
retain the previous snapshot. All internal attempts share one deadline. Header
waiting uses the remaining deadline, and expiry retains the existing 504 response.

There is no new environment variable. Native overrides the former
`ANTIGRAVITY_TIMEOUT_HEADERS` and `ANTIGRAVITY_TIMEOUT_TOTAL` caps. Connect and
write retain their existing defaults (15 and 30 seconds) and overrides. Real
streaming and stream collection retain their existing limits and ENV semantics.
Clients or reverse proxies may impose their own shorter timeout.

Panels connected to an older service disable this setting and omit it from saves
unless the capability is present. No management protocol or manager work is needed.
