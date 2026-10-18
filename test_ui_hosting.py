"""In-memory ASGI hosting tests; no real startup, storage, OAuth or network."""
from __future__ import annotations

from html.parser import HTMLParser
import importlib.util
import json
from pathlib import Path
from urllib.parse import urljoin
import socket
import sys

import pytest
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.testclient import TestClient


ROOT = Path(__file__).resolve().parent
SHELL = '''<!doctype html><html><head>
<meta name="gcli-embed-policy" content="__GCLI_EMBED_POLICY__">
<meta name="gcli-service-base" content="__GCLI_SERVICE_BASE__">
<script type="module" src="./assets/index-abcD1234.js"></script>
</head><body><div id="root"></div></body></html>'''


class Metadata(HTMLParser):
    def __init__(self, content):
        super().__init__()
        self.values = {}
        self.feed(content)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "meta" and "name" in attrs:
            self.values[attrs["name"]] = attrs.get("content")


@pytest.fixture
def hosting(monkeypatch, tmp_path):
    # These guards precede importing project modules; the config cache never reads storage.
    monkeypatch.setenv("CREDENTIALS_DIR", str(tmp_path / "fake-credentials"))
    monkeypatch.setenv("ENABLE_LOG", "0")
    monkeypatch.setenv("LOG_FILE", str(tmp_path / "unused.log"))
    for key in ("POSTGRESQL_URI", "MYSQL_URI", "MONGODB_URI", "DATABASE_URL", "KEEPALIVE_URL", "GCLI_EMBED_ALLOWED_ORIGINS"):
        monkeypatch.delenv(key, raising=False)
    original_connect = socket.socket.connect

    def no_external_socket(sock, address):
        if not isinstance(address, tuple) or address[0] not in ("127.0.0.1", "::1", "localhost"):
            raise AssertionError("UI hosting tests must not connect externally")
        return original_connect(sock, address)

    monkeypatch.setattr(socket.socket, "connect", no_external_socket)
    import config
    monkeypatch.setattr(config, "_config_initialized", True)
    monkeypatch.setattr(config, "_config_cache", {})
    from src.panel import ui
    return ui, config


@pytest.fixture
def dist(tmp_path):
    path = tmp_path / "ui-dist"
    (path / "assets").mkdir(parents=True)
    (path / "index.html").write_text(SHELL, encoding="utf-8")
    (path / "assets" / "index-abcD1234.js").write_text('export const fixture = true;', encoding="utf-8")
    (path / "assets" / "style-1234abcd.css").write_text('body { color: black; }', encoding="utf-8")
    (path / "assets" / "plain.js").write_text('export {};', encoding="utf-8")
    (path / "private.txt").write_text('not-public', encoding="utf-8")
    (path / ".vite").mkdir()
    (path / ".vite" / "manifest.json").write_text('{}', encoding="utf-8")
    return path


def client_for(hosting, dist, *, root_path=""):
    ui, _ = hosting
    app = FastAPI()
    from src.panel.root import router
    app.include_router(router)
    app.mount("/front", StaticFiles(directory=ROOT / "front"), name="front")
    ui.install_ui(app, dist)
    return TestClient(app, root_path=root_path)


@pytest.mark.parametrize("root_path,expected", [("", "/"), ("/", "/"), ("/edge/node", "/edge/node/"), ("/edge/node/", "/edge/node/")])
def test_canonical_redirect_preserves_query_and_trusted_prefix(hosting, dist, root_path, expected):
    client = client_for(hosting, dist, root_path=root_path)
    response = client.get("/ui?a=1&a=2&return=%2Ffoo%3Fx%3D1", follow_redirects=False,
                          headers={"X-Forwarded-Prefix": "//attacker.invalid", "X-Forwarded-Host": "attacker.invalid"})
    assert response.status_code == 307
    assert response.headers["location"] == expected + "ui/?a=1&a=2&return=%2Ffoo%3Fx%3D1"
    assert response.headers["cache-control"] == "no-store"
    # ASGI root_path is normally slash-less; verify the normalized Location
    # through that standard scope instead of promising a server prefix rewrite.
    normalized = client_for(hosting, dist, root_path=root_path.rstrip("/"))
    assert normalized.get(response.headers["location"]).status_code == 200


@pytest.mark.parametrize("mode,origins,csp", [
    ("any_https", [], "frame-ancestors https:"),
    ("disabled", [], "frame-ancestors 'none'"),
    ("exact", ["https://console.example.invalid"], "frame-ancestors https://console.example.invalid"),
    ("exact", ["https://invalid.example.invalid/path"], "frame-ancestors 'none'"),
])
def test_html_injects_existing_policy_and_no_store(hosting, dist, mode, origins, csp):
    _, config = hosting
    config._config_cache.update({config.GCLI_EMBED_MODE_KEY: mode, config.GCLI_EMBED_ORIGINS_KEY: origins})
    response = client_for(hosting, dist, root_path="/node").get("/node/ui/")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["content-security-policy"] == csp
    assert "x-frame-options" not in response.headers
    values = Metadata(response.text).values
    assert values["gcli-service-base"] == "/node/"
    policy = json.loads(values["gcli-embed-policy"])
    assert policy["mode"] == ("disabled" if "/path" in str(origins) else mode)
    assert "__GCLI_" not in response.text
    assert './assets/index-abcD1234.js' in response.text
    # HTML is read dynamically and never serves a stale cached copy.
    (dist / "index.html").write_text(SHELL.replace('id="root"', 'id="new-root"'), encoding="utf-8")
    assert 'id="new-root"' in client_for(hosting, dist).get("/ui/").text


def test_metadata_is_escaped_and_prefix_cannot_become_an_external_url(hosting, dist, monkeypatch):
    ui, _ = hosting
    from src.embed_policy import EmbedPolicy
    attack = '\"><script>alert("fixture")</script>&'

    async def fake_policy():
        # Malformed policy is injected only to test the HTML boundary, never storage.
        return EmbedPolicy(mode=attack, origins=())

    monkeypatch.setattr(ui, "get_embed_policy", fake_policy)
    client = client_for(hosting, dist, root_path='//node/quote"&<>')
    response = client.get('/ui/')
    assert response.status_code == 200
    assert attack not in response.text
    assert json.loads(Metadata(response.text).values["gcli-embed-policy"])["mode"] == attack
    assert Metadata(response.text).values["gcli-service-base"] == '/node/quote%22%26%3C%3E/'
    redirect = client.get('/ui?x=%3C%22', follow_redirects=False)
    assert redirect.headers['location'] == '/node/quote%22%26%3C%3E/ui/?x=%3C%22'


@pytest.mark.parametrize("missing", ["tree", "index", "assets", "placeholders", "invalid-encoding"])
def test_missing_or_invalid_build_preserves_legacy(hosting, dist, missing, monkeypatch):
    if missing == "tree":
        dist = dist / "absent"
    elif missing == "index":
        (dist / "index.html").unlink()
    elif missing == "assets":
        (dist / "assets").rename(dist / "not-mounted")
    elif missing == "placeholders":
        (dist / "index.html").write_text('<html>wrong build</html>', encoding="utf-8")
    else:
        (dist / "index.html").write_bytes(b'\xff\xfe')
    monkeypatch.chdir(ROOT)
    client = client_for(hosting, dist)
    response = client.get('/ui/')
    assert response.status_code == 503
    assert response.headers['cache-control'] == 'no-store'
    assert response.headers['content-security-policy'] == 'frame-ancestors https:'
    assert '<a href="/legacy">' in response.text
    assert str(dist) not in response.text
    for path in ('/legacy', '/model-routing', '/front/common.js'):
        assert client.get(path).status_code == 200


def test_missing_build_fallback_link_preserves_prefix(hosting, tmp_path):
    response = client_for(hosting, tmp_path / 'absent', root_path='/node').get('/ui/')
    assert response.status_code == 503
    assert '<a href="/node/legacy">' in response.text


@pytest.mark.parametrize("path,mime", [('index-abcD1234.js', 'text/javascript'), ('style-1234abcd.css', 'text/css')])
def test_assets_have_real_mime_immutable_and_conditional_responses(hosting, dist, path, mime):
    client = client_for(hosting, dist, root_path='/node')
    response = client.get('/node/ui/assets/' + path)
    assert response.status_code == 200
    assert response.headers['content-type'].split(';')[0] == mime
    assert response.headers['cache-control'] == 'public, max-age=31536000, immutable'
    assert response.headers['x-content-type-options'] == 'nosniff'
    unchanged = client.get('/node/ui/assets/' + path, headers={'If-None-Match': response.headers['etag']})
    assert unchanged.status_code == 304
    assert 'immutable' in unchanged.headers['cache-control']
    assert not unchanged.content
    head = client.head('/node/ui/assets/' + path)
    assert head.status_code == 200 and not head.content
    assert client.post('/node/ui/assets/' + path).status_code == 405
    plain = client.get('/node/ui/assets/plain.js')
    assert plain.headers['cache-control'] == 'no-cache'


@pytest.mark.parametrize('path', [
    '/ui/index.html', '/ui/private.txt', '/ui/.vite/manifest.json', '/ui/unknown',
    '/ui/assets/not-found.js', '/ui/assets/', '/ui/assets/%2e%2e/index.html',
    '/ui/assets/%2e%2e/private.txt', '/ui/assets/%2e%2e%2findex.html',
])
def test_only_asset_subtree_is_public_without_spa_fallback(hosting, dist, path):
    response = client_for(hosting, dist).get(path)
    assert response.status_code == 404
    assert 'text/html' not in response.headers.get('content-type', '')
    assert 'not-public' not in response.text
    assert 'immutable' not in response.headers.get('cache-control', '')


def test_app_import_without_dist_registers_existing_routes_without_lifespan(hosting, monkeypatch, tmp_path):
    ui, _ = hosting
    install = ui.install_ui
    monkeypatch.setattr(ui, 'install_ui', lambda app: install(app, tmp_path / 'absent'))
    # Import only: TestClient is deliberately not entered as a context manager.
    cached_web = sys.modules.get('web')
    cached_app = getattr(cached_web, 'app', None)
    # Other test modules may already have imported web with a real UI build.
    # Load a separate app without replacing their cached module or app instance.
    spec = importlib.util.spec_from_file_location('_ui_hosting_web', ROOT / 'web.py')
    web = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(web)
    client = TestClient(web.app)
    assert client.get('/ui/').status_code == 503
    assert client.get('/', follow_redirects=False).headers['location'] == '/ui/'
    assert client.get('/legacy').status_code == 200
    assert client.get('/model-routing').status_code == 200
    paths = web.app.openapi()['paths']
    assert '/v1/chat/completions' in paths
    assert '/antigravity/v1/chat/completions' in paths
    assert sys.modules.get('web') is cached_web
    if cached_web is not None:
        assert cached_web.app is cached_app
        assert web.app is not cached_app


@pytest.mark.parametrize("root_path,base", [("", "/"), ("/edge/node", "/edge/node/"), ("/edge/node/", "/edge/node/")])
@pytest.mark.parametrize("source,target", [("/", "ui/"), ("/legacy/", "legacy")])
def test_default_and_legacy_redirects_preserve_query_and_trusted_prefix(hosting, dist, root_path, base, source, target):
    client = client_for(hosting, dist, root_path=root_path)
    response = client.get(source + "?a=1&a=2&return=%2Ffoo%3Fx%3D1", follow_redirects=False,
                          headers={"X-Forwarded-Prefix": "//attacker.invalid", "X-Forwarded-Host": "attacker.invalid"})
    assert response.status_code == 307
    assert response.headers["location"] == base + target + "?a=1&a=2&return=%2Ffoo%3Fx%3D1"
    assert "#" not in response.headers["location"]
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("mobile", [False, True])
@pytest.mark.parametrize("prefix", ["", "/edge/node"])
def test_legacy_page_remains_usable_with_original_relative_endpoints(hosting, dist, monkeypatch, mobile, prefix):
    monkeypatch.chdir(ROOT)
    client = client_for(hosting, dist, root_path=prefix)
    response = client.get(prefix + "/legacy", headers={"User-Agent": "iPhone Mobile" if mobile else "Desktop"})
    expected = (ROOT / "front" / ("control_panel_mobile.html" if mobile else "control_panel.html")).read_text(encoding="utf-8")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["content-security-policy"] == "frame-ancestors https:"
    assert "__GCLI2API_ASSET_VERSION__" not in response.text
    assert "__GCLI_EMBED_POLICY__" not in response.text
    # The handler still selects the correct existing page; its script path is intact.
    assert '<script src="./front/common.js?v=' in response.text
    expected_title = expected.split("<title>", 1)[1].split("</title>", 1)[0]
    assert "<title>" + expected_title + "</title>" in response.text
    page = "https://node.example.invalid" + prefix + "/legacy?mode=synthetic#config"
    for relative in ("./front/common.js", "./auth/login", "./creds/status", "./config/get", "./logs/stream", "./model-routing", "docs/qq群.jpg"):
        resolved = urljoin(page, relative)
        assert resolved == "https://node.example.invalid" + prefix + "/" + relative.removeprefix("./")
    assert client.get(prefix + "/front/common.js").status_code == 200


def test_missing_ui_fallback_has_no_default_entry_redirect_loop(hosting, tmp_path, monkeypatch):
    monkeypatch.chdir(ROOT)
    client = client_for(hosting, tmp_path / "absent", root_path="/node")
    redirect = client.get("/node/", follow_redirects=False)
    assert redirect.headers["location"] == "/node/ui/"
    unavailable = client.get(redirect.headers["location"])
    assert unavailable.status_code == 503
    assert '<a href="/node/legacy">' in unavailable.text
    assert client.get("/node/legacy").status_code == 200
    assert client.get("/node/legacy/", follow_redirects=False).headers["location"] == "/node/legacy"
