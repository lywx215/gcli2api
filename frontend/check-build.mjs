import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const out = resolve("../ui-dist");
const html = readFileSync(resolve(out, "index.html"), "utf8");
const manifest = JSON.parse(readFileSync(resolve(out, ".vite/manifest.json"), "utf8"));
const assets = readdirSync(resolve(out, "assets"));
const js = assets.filter(file => file.endsWith(".js"));
const css = assets.filter(file => file.endsWith(".css"));
assert(js.length >= 2, "Must ship independent lazy JS chunks");
assert(css.length >= 1, "Must ship independent CSS");
assert([...js, ...css].every(file => /-[A-Za-z0-9_-]{8,}\.(js|css)$/.test(file)), "Assets must carry content hashes");
assert(Object.values(manifest).some(entry => entry.isDynamicEntry), "Manifest must contain a dynamic entry");
assert(html.includes('src="./assets/'), "Assets must be relative to canonical /ui/");
assert(html.includes('name="gcli-service-base" content="__GCLI_SERVICE_BASE__"'), "Service-base injection point missing");
assert(html.includes('name="gcli-embed-policy" content="__GCLI_EMBED_POLICY__"'), "Embed-policy injection point missing");
assert(!/<script(?![^>]*src=)[^>]*>[^<]+/.test(html), "No inline bootstrap JS");
for (const file of js) {
  const body = readFileSync(resolve(out, "assets", file), "utf8");
  assert(!body.includes("synthetic-ui-session") && !body.includes("synthetic_fixture_not_registered"), "DEV fixture leaked into production");
}
console.log(`Build verified: ${js.length} hashed JS chunks, ${css.length} hashed CSS, dynamic import, injection points, no DEV fixtures.`);
