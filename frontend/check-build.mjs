import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, sep } from "node:path";
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
const pageEntries = ["overview", "credentials", "import", "settings", "logs"].map(name => {
  const entry = manifest[`src/pages/${name}/index.tsx`];
  assert(entry?.isDynamicEntry, `${name} must have a real lazy entry`);
  return entry.file;
});
assert(new Set(pageEntries).size === 5, "Every page must have its own lazy JS file");
for (const [key, entry] of Object.entries(manifest)) {
  for (const file of [entry.file, ...(entry.css ?? []), ...(entry.assets ?? [])]) {
    const target = resolve(out, file);
    assert(target.startsWith(out + sep) && existsSync(target), `${key} references a missing or unsafe asset: ${file}`);
  }
  for (const dependency of [...(entry.imports ?? []), ...(entry.dynamicImports ?? [])]) {
    assert(manifest[dependency], `${key} references a missing manifest entry: ${dependency}`);
  }
}
assert(html.includes('src="./assets/'), "Assets must be relative to canonical /ui/");
assert(html.includes('name="gcli-service-base" content="__GCLI_SERVICE_BASE__"'), "Service-base injection point missing");
assert(html.includes('name="gcli-embed-policy" content="__GCLI_EMBED_POLICY__"'), "Embed-policy injection point missing");
assert(!/<script(?![^>]*src=)[^>]*>[^<]+/.test(html), "No inline bootstrap JS");
assert(!Object.keys(manifest).some(key => /(?:^|\/)fixtures(?:\.|\/)/.test(key)), "DEV fixture modules leaked into production manifest");
for (const file of js) {
  const body = readFileSync(resolve(out, "assets", file), "utf8");
  for (const marker of ["synthetic-ui-session", "synthetic_fixture_not_registered", "synthetic-", "example.invalid", "Synthetic preview only"]) {
    assert(!body.includes(marker), `DEV fixture marker leaked into production: ${marker} in ${file}`);
  }
}
console.log(`Build verified: ${js.length} hashed JS chunks, ${css.length} hashed CSS, five independent pages, complete manifest references, injection points, no DEV fixtures.`);
