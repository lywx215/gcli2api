"""Isolated panel checks and an opt-in, loopback-only mock UI server.

Run ``python test_model_routing_panel.py --serve`` for browser QA. This does
not import web, open a database, initialize storage, or invoke OAuth/listing.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile

# Isolation precedes importing any project module.
_ISOLATED_DIR = tempfile.TemporaryDirectory(prefix="model-routing-panel-")
os.environ["CREDENTIALS_DIR"] = _ISOLATED_DIR.name
os.environ["ENABLE_LOG"] = "0"
os.environ["LOG_FILE"] = str(Path(_ISOLATED_DIR.name) / "unused.log")
for _key in ("POSTGRESQL_URI", "MYSQL_URI", "MONGODB_URI", "DATABASE_URL", "GCLI_SERVER_NAME", "PROXY", "KEEPALIVE_URL"):
    os.environ.pop(_key, None)
for _key in ("CODE_ASSIST_ENDPOINT", "OAUTH_PROXY_URL", "GOOGLEAPIS_PROXY_URL", "RESOURCE_MANAGER_API_URL", "SERVICE_USAGE_API_URL", "ANTIGRAVITY_API_URL"):
    os.environ[_key] = "http://127.0.0.1:1"

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.testclient import TestClient

import config

config._config_initialized = True
config._config_cache = {}

from src.panel.root import router

ROOT = Path(__file__).resolve().parent
MOCK_TOKEN = "panel-ui-fixture"


def create_mock_app() -> FastAPI:
    """Purpose-built local UI fixtures, never the application's lifespan."""
    app = FastAPI()
    app.include_router(router)
    app.mount("/front", StaticFiles(directory=ROOT / "front"), name="front")
    state = {"routes": [], "get_status": 200, "put_status": 200, "commit_before_error": False, "puts": [], "requests": []}
    app.state.routing_fixture = state

    def payload():
        return {
            "routes": state["routes"],
            "supported_channels": ["geminicli", "antigravity"],
            "capabilities": ["model.routing.aliases", "model.identity.public"],
            "policy_digest": "fixture-policy",
            "validation": {
                "geminicli": {"valid": True, "issues": []},
                "antigravity": {"valid": True, "issues": []},
            },
        }

    @app.post("/auth/login")
    async def login(request: Request):
        if (await request.json()).get("password") != MOCK_TOKEN:
            raise HTTPException(401, "密码错误")
        return {"token": MOCK_TOKEN, "message": "登录成功"}

    @app.api_route("/config/model-routing", methods=["GET", "PUT"])
    async def routing(request: Request):
        state["requests"].append({"method": request.method, "path": request.url.path})
        if request.headers.get("authorization") != f"Bearer {MOCK_TOKEN}":
            raise HTTPException(403, "认证失败")
        result_status = state["get_status" if request.method == "GET" else "put_status"]
        if request.method == "PUT":
            body = await request.json()
            state["puts"].append(body)
            if state["commit_before_error"] and result_status >= 500:
                state["routes"] = body["routes"]
        if result_status == 400:
            return JSONResponse(status_code=400, content={"error": {
                "code": "MODEL_ROUTING_VALIDATION_FAILED",
                "message": "Invalid model routing configuration.",
                "issues": [{"channel": "antigravity", "row": 1, "field": "public_name", "reason": "DUPLICATE_PUBLIC_NAME", "related_rows": [0], "message": "Invalid model routing configuration."}],
            }})
        if result_status != 200:
            return JSONResponse(status_code=result_status, content={"error": {"code": "MODEL_ROUTING_CONFIG_UNAVAILABLE", "message": "Model routing configuration is unavailable."}})
        if request.method == "PUT":
            state["routes"] = body["routes"]
        return payload()

    @app.post("/_mock/control")
    async def control(request: Request):
        changes = await request.json()
        for key in ("routes", "get_status", "put_status", "commit_before_error"):
            if key in changes:
                state[key] = changes[key]
        return {"ok": True}

    @app.get("/_mock/state")
    async def inspect():
        return state

    return app


@pytest.fixture(autouse=True)
def isolated_configuration(monkeypatch):
    monkeypatch.setattr(config, "_config_initialized", True)
    monkeypatch.setattr(config, "_config_cache", {})
    monkeypatch.delenv("GCLI_EMBED_ALLOWED_ORIGINS", raising=False)

    original_connect = socket.socket.connect

    def no_external_connection(sock, address):
        # Windows asyncio uses a loopback socket pair for its event loop.
        if not isinstance(address, tuple) or address[0] not in ("127.0.0.1", "::1", "localhost"):
            raise AssertionError("Panel tests must not open an external socket")
        return original_connect(sock, address)

    monkeypatch.setattr(socket.socket, "connect", no_external_connection)


@pytest.mark.parametrize("user_agent", ["Desktop UI fixture", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile"])
def test_dedicated_page_uses_existing_policy_and_versioned_resources(monkeypatch, user_agent):
    monkeypatch.setenv("GCLI_EMBED_ALLOWED_ORIGINS", "https://console.example.test")
    client = TestClient(create_mock_app())
    response = client.get("/model-routing", headers={"user-agent": user_agent})
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["content-security-policy"] == "frame-ancestors https://console.example.test"
    assert "__GCLI2API_ASSET_VERSION__" not in response.text
    assert "__GCLI_EMBED_POLICY__" not in response.text
    for filename in ("common.js", "model_routing.js", "model_routing.css"):
        assert f"./front/{filename}?v=" in response.text
    assert MOCK_TOKEN not in response.text
    assert "upstream_name" not in response.text
    assert response.text.count('role="tab"') == 2
    assert 'data-channel="geminicli"' in response.text
    assert 'data-channel="antigravity"' in response.text
    assert "Vertex" not in response.text


def test_page_policy_fails_closed_for_invalid_embedding(monkeypatch):
    monkeypatch.setenv("GCLI_EMBED_ALLOWED_ORIGINS", "http://console.example.test")
    response = TestClient(create_mock_app()).get("/model-routing")
    assert response.status_code == 200
    assert response.headers["content-security-policy"] == "frame-ancestors 'none'"


@pytest.mark.parametrize("user_agent", ["Desktop UI fixture", "Mozilla/5.0 (iPhone) Mobile"])
def test_existing_panels_keep_features_and_link_without_auth_query(user_agent):
    response = TestClient(create_mock_app()).get("/", headers={"user-agent": user_agent})
    assert response.status_code == 200
    assert 'href="./model-routing"' in response.text
    for marker in ("antigravity-manage", "configPanelPassword", "rtRefreshToken", "quotaFallbackCooldownMinutes", "uploadArea"):
        assert marker in response.text
    assert 'href="./model-routing?' not in response.text


def test_editor_reuses_panel_auth_without_draft_persistence_or_side_effects():
    js = (ROOT / "front/model_routing.js").read_text(encoding="utf-8")
    common = (ROOT / "front/common.js").read_text(encoding="utf-8")
    assert "readStoredAuthToken()" in js
    assert "writeStoredAuthToken(data.token)" in js
    assert "clearStoredAuthToken()" in js
    assert "localStorage" not in js and "sessionStorage" not in js
    assert "'Authorization': `Bearer ${AppState.authToken}`" in js
    assert "./auth/login" in js and "./config/model-routing" in js
    for endpoint in ("creds/", "config/get", "auth/start", "version/"):
        assert endpoint not in js
    assert common.count("if (isModelRoutingPage()) return;") >= 3
    assert "'beforeunload', beforeUnload" in js
    assert "related_rows" in js
    assert "仅匹配完整名称；-search 不会自动联网。" in js


def test_mock_api_demonstrates_auth_and_full_table_fixture():
    client = TestClient(create_mock_app())
    assert client.get("/config/model-routing").status_code == 403
    assert client.post("/auth/login", json={"password": "wrong-fixture"}).status_code == 401
    token = client.post("/auth/login", json={"password": MOCK_TOKEN}).json()["token"]
    rows = [{"channel": "geminicli", "public_name": "public-alpha", "upstream_name": "fixture-one", "enabled": True}, {"channel": "antigravity", "public_name": "public-beta", "upstream_name": "fixture-two", "enabled": False}]
    response = client.put("/config/model-routing", json={"routes": rows}, headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 200
    assert response.json()["routes"] == rows
    assert client.get("/_mock/state").json()["puts"] == [{"routes": rows}]


def test_editor_interaction_matrix_in_isolated_javascript_runtime():
    """Exercise actual editor event handlers against a minimal, in-memory DOM.

    This verifies state transitions; real layout/browser checks are separate.
    No application private state is exposed to the harness.
    """
    node = shutil.which("node") or str(Path.home() / ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe")
    if not Path(node).exists():
        pytest.skip("Node unavailable; the browser interaction gate remains unverified")
    script = r"""
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
class Element {
  constructor(tag='div') {
    this.tag = tag; this.children = []; this.attrs = {}; this.dataset = {};
    this.listeners = {}; this.hidden = false; this.disabled = false;
    this.value = ''; this.checked = false; this.textContent = '';
    const classes = new Set();
    this.classList = {toggle:(name,on)=>on?classes.add(name):classes.delete(name)};
  }
  append(...elements) { for(const element of elements) {element.parent=this;this.children.push(element);} }
  appendChild(element) {this.append(element);return element;}
  replaceChildren(...elements) {this.children=[];this.append(...elements);}
  addEventListener(name, fn, options={}) {(this.listeners[name] ||= []).push({fn,once:options.once});}
  async emit(name, event={}) {for(const item of [...(this.listeners[name]||[])]) {if(item.once)this.listeners[name]=this.listeners[name].filter(x=>x!==item);await item.fn(event);}}
  setAttribute(name,value) {this.attrs[name]=String(value);}
  getAttribute(name) {return this.attrs[name] ?? null;}
  removeAttribute(name) {delete this.attrs[name];}
  focus() {document.activeElement=this;}
  scrollIntoView() {}
  showModal() {this.open=true;}
  async close(value) {this.open=false;this.returnValue=value;await this.emit('close');}
}
const roots=[];
const all = () => {const items=[];const walk=e=>{items.push(e);e.children.forEach(walk);};roots.forEach(walk);return items;};
const document = {
  listeners:{}, activeElement:null,
  getElementById:id=>all().find(element=>element.id===id),
  createElement:tag=>new Element(tag),
  addEventListener(name,fn){(this.listeners[name]||=[]).push(fn);},
  querySelector:selector=>all().find(e=>e.className==='route-columns'),
  querySelectorAll:selector=>all().filter(e=>e.dataset.channel || (selector.includes('#routeRows') && ['input','button'].includes(e.tag) && (()=>{let p=e.parent;while(p){if(p.id==='routeRows')return true;p=p.parent;}return false;})()))
};
const html = fs.readFileSync('front/model_routing.html','utf8');
for(const match of html.matchAll(/<([a-z]+)[^>]*\bid="([^"]+)"[^>]*>/g)) {
  const element=new Element(match[1]);element.id=match[2];roots.push(element);
}
const columns=new Element();columns.className='route-columns';roots.push(columns);
const get=id=>document.getElementById(id);
get('tab-geminicli').dataset.channel='geminicli';get('tab-antigravity').dataset.channel='antigravity';
get('backToPanel').href='http://fixture/#config';
const window = {listeners:{},location:{assign(value){window.destination=value;}},
 addEventListener(name,fn){this.listeners[name]=fn;},removeEventListener(name){delete this.listeners[name];}};
const backend={rows:[],get:200,put:200,commitBeforeError:false,requests:[],puts:[]};
let token='';
const AppState={authToken:''};
const payload=()=>({routes:structuredClone(backend.rows),validation:{geminicli:{issues:[]},antigravity:{issues:[]}}});
const fetch=async(path,options={})=>{
  backend.requests.push(path);
  if(path==='./auth/login') {
    const valid=JSON.parse(options.body).password==='fixture';
    return {ok:valid,status:valid?200:401,json:async()=>({token:valid?'fixture':undefined})};
  }
  assert.equal(path,'./config/model-routing');
  assert.equal(options.headers.Authorization,'Bearer fixture');
  let code=options.method==='PUT'?backend.put:backend.get;
  if(options.method==='PUT')backend.puts.push(JSON.parse(options.body));
  if(options.method==='PUT' && (code===200 || (backend.commitBeforeError && code>=500)))backend.rows=structuredClone(backend.puts.at(-1).routes);
  const data=code===400?{error:{issues:[{channel:'antigravity',row:1,field:'public_name',reason:'DUPLICATE_PUBLIC_NAME',related_rows:[0]}]}}:code===200?payload():{};
  return {ok:code===200,status:code,json:async()=>data};
};
vm.runInNewContext(fs.readFileSync('front/model_routing.js','utf8'),{document,window,fetch,AppState,
 readStoredAuthToken:()=>token,writeStoredAuthToken:value=>token=value,clearStoredAuthToken:()=>token=''});
const click=id=>get(id).emit('click',{preventDefault(){this.prevented=true;}});
const input=async(id,value)=>{get(id).value=value;await get(id).emit('input');};
const login=async password=>{get('routingPassword').value=password;await get('routingLoginForm').emit('submit',{preventDefault(){}});};
const confirm=async(id,result)=>{const action=click(id);await Promise.resolve();assert.equal(get('discardDialog').open,true);await get('discardDialog').close(result);await action;};
(async()=>{
  await document.listeners.DOMContentLoaded[0]();
  assert.equal(get('routingLogin').hidden,false);assert.equal(backend.requests.length,0);
  await login('wrong');assert.equal(get('routingEditor').hidden,true);
  await login('fixture');assert.equal(get('routingEditor').hidden,false);assert.equal(get('saveRoutes').disabled,true);
  await click('addRoute');await input('row-0-public_name','public-alpha');await input('row-0-upstream_name','fixture-one');
  await click('tab-antigravity');await click('addRoute');await input('row-1-public_name','public-beta');await input('row-1-upstream_name','fixture-two');
  get('row-1-enabled').checked=false;await get('row-1-enabled').emit('change');
  await click('tab-geminicli');assert.equal(get('row-0-public_name').value,'public-alpha');
  let prevented=false;const unload={preventDefault(){prevented=true;}};window.listeners.beforeunload(unload);assert.equal(prevented,true);assert.equal(unload.returnValue,'');
  backend.put=400;await click('saveRoutes');
  assert.equal(get('routingStatus').textContent,'保存未生效。请修正校验错误，两个渠道的草稿均已保留。');
  assert.equal(backend.puts.at(-1).routes.length,2);assert.equal(backend.puts.at(-1).routes[1].enabled,false);
  assert.equal(document.activeElement.id,'row-1-public_name');assert.equal(get('errors-geminicli').textContent,'1');assert.equal(get('errors-antigravity').textContent,'1');
  await click('tab-geminicli');assert.equal(get('row-errors-0').hidden,false);await input('row-0-upstream_name','fixture-fixed');
  assert.equal(get('errors-geminicli').hidden,true);assert.equal(get('errors-antigravity').hidden,true);
  const uncertain='保存结果无法确认，配置可能已经生效，请重新加载核对；草稿保留。';
  for(const code of [503,500,502,504]) {
    backend.put=code;await click('saveRoutes');
    assert.equal(get('routingStatus').textContent,uncertain);
    assert.equal(get('saveRoutes').disabled,false);assert.equal(get('row-0-upstream_name').value,'fixture-fixed');
    assert.equal(get('draftState').dataset.dirty,'true');assert.ok(window.listeners.beforeunload);
    assert.deepEqual(backend.rows,[]);
  }
  backend.put=401;await click('saveRoutes');assert.equal(get('routingLogin').hidden,false);assert.equal(token,'');
  assert.equal(get('routingStatus').textContent,'登录已失效，请重新登录。当前草稿仍保留。');
  await login('fixture');assert.equal(get('row-0-upstream_name').value,'fixture-fixed');assert.equal(get('draftState').dataset.dirty,'true');
  backend.put=403;await click('saveRoutes');assert.equal(get('routingLogin').hidden,false);assert.equal(token,'');
  const gets=backend.requests.filter(p=>p==='./config/model-routing').length;
  await login('fixture');assert.equal(backend.requests.filter(p=>p==='./config/model-routing').length,gets);assert.equal(get('row-0-upstream_name').value,'fixture-fixed');
  await confirm('reloadRoutes','cancel');assert.equal(get('saveRoutes').disabled,false);
  await confirm('backToPanel','cancel');assert.equal(window.destination,undefined);assert.equal(get('row-0-public_name').value,'public-alpha');
  backend.get=503;await confirm('reloadRoutes','discard');assert.equal(get('row-0-upstream_name').value,'fixture-fixed');assert.ok(window.listeners.beforeunload);
  backend.put=200;await click('saveRoutes');assert.equal(get('saveRoutes').disabled,true);assert.equal(window.listeners.beforeunload,undefined);
  await click('tab-antigravity');assert.ok(get('channelHint').textContent.includes('仅匹配完整名称；-search 不会自动联网。'));
  await click('reloadRoutes');assert.equal(get('row-1-public_name').value,'public-beta');
  backend.get=200;await click('reloadRoutes');assert.equal(get('saveRoutes').disabled,true);
  await input('row-1-public_name','public-beta-fixed');await confirm('routingLogout','cancel');assert.equal(token,'fixture');
  await confirm('routingLogout','discard');assert.equal(token,'');assert.equal(window.listeners.beforeunload,undefined);
  backend.get=503;await login('fixture');assert.equal(get('repairRoutes').hidden,false);
  await confirm('repairRoutes','discard');assert.equal(get('saveRoutes').disabled,false);
  await click('saveRoutes');assert.deepEqual(backend.puts.at(-1).routes,[]);assert.equal(window.listeners.beforeunload,undefined);
  backend.rows=[{channel:'geminicli',public_name:7,upstream_name:'fixture-one',enabled:1,unknown:'invalid-field'}];backend.get=200;await click('reloadRoutes');await click('tab-geminicli');
  assert.equal(get('row-0-public_name').value,'7');await input('row-0-public_name','public-fixed');await click('saveRoutes');
  assert.equal(backend.puts.at(-1).routes[0].unknown,'invalid-field');assert.equal(backend.puts.at(-1).routes[0].enabled,1);
  await get('routeRows').children[0].children[1].children[3].emit('click');await click('saveRoutes');assert.deepEqual(backend.puts.at(-1).routes,[]);
  await click('addRoute');await input('row-0-public_name','public-after-commit');await input('row-0-upstream_name','fixture-after-commit');
  await click('tab-antigravity');await click('addRoute');await input('row-1-public_name','public-after-ag');await input('row-1-upstream_name','fixture-after-ag');
  backend.commitBeforeError=true;backend.put=503;await click('saveRoutes');
  const committed=structuredClone(backend.puts.at(-1).routes);
  assert.equal(committed.length,2);assert.deepEqual(backend.rows,committed);
  assert.equal(get('routingStatus').textContent,uncertain);assert.equal(get('saveRoutes').disabled,false);
  assert.equal(get('draftState').dataset.dirty,'true');assert.ok(window.listeners.beforeunload);
  assert.equal(get('row-1-public_name').value,'public-after-ag');
  await click('tab-geminicli');await input('row-0-public_name','public-local-only');
  assert.equal(backend.rows[0].public_name,'public-after-commit');
  await confirm('reloadRoutes','discard');
  assert.equal(get('row-0-public_name').value,'public-after-commit');assert.equal(get('row-0-upstream_name').value,'fixture-after-commit');
  assert.equal(get('routingStatus').textContent,'已加载全部路由。');assert.equal(get('saveRoutes').disabled,true);
  assert.equal(get('draftState').dataset.dirty,'false');assert.equal(window.listeners.beforeunload,undefined);
  await click('tab-antigravity');assert.equal(get('row-1-public_name').value,'public-after-ag');assert.deepEqual(backend.rows,committed);
  process.stdout.write('editor interaction matrix passed\n');
})().catch(error=>{console.error(error);process.exitCode=1;});
"""
    result = subprocess.run([node, "-e", script], cwd=ROOT, text=True, capture_output=True, timeout=20)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "editor interaction matrix passed" in result.stdout


def run_isolated_browser_check():
    """Fallback QA after the in-app browser's native-dialog control failed.

    Launch a disposable headless browser context without reading a user
    profile. Every page request is restricted to the loopback mock origin.
    This helper requires the separate --serve fixture, never web.py.
    """
    bundle = Path.home() / ".cache/codex-runtimes/codex-primary-runtime/dependencies/node"
    node = bundle / "bin/node.exe"
    package = bundle / "node_modules/playwright"
    chrome = Path("C:/Program Files/Google/Chrome/Application/chrome.exe")
    if not all(path.exists() for path in (node, package, chrome)):
        raise SystemExit("Isolated browser QA unavailable; browser gate unverified")
    output = os.environ.get("PANEL_UI_SCREENSHOTS", _ISOLATED_DIR.name)
    script = r"""
const { chromium, request } = require(process.env.PANEL_UI_PLAYWRIGHT);
const assert = require('node:assert/strict');
const path = require('node:path');
const origin = 'http://127.0.0.1:18765';
const rows = [
 {channel:'geminicli',public_name:'public-alpha',upstream_name:'fixture-one',enabled:true},
 {channel:'antigravity',public_name:'public-beta',upstream_name:'fixture-two',enabled:false}
];
(async()=>{
 const api = await request.newContext({baseURL:origin});
 const control = async value => {const response=await api.post('/_mock/control',{data:value});assert.equal(response.ok(),true);};
 await control({routes:[],get_status:200,put_status:200,commit_before_error:false});
 const browser = await chromium.launch({headless:true,executablePath:process.env.PANEL_UI_CHROME,
  args:['--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run','--disable-default-apps']});
 const context = await browser.newContext({viewport:{width:1280,height:900},serviceWorkers:'block'});
 const outbound=[];
 await context.route('**/*',route=>{
   if(new URL(route.request().url()).origin===origin)return route.continue();
   outbound.push(route.request().url());return route.abort();
 });
 const page = await context.newPage();
 const button=name=>page.getByRole('button',{name,exact:true});
 const field=(number,name)=>page.getByRole('textbox',{name:`第 ${number} 行${name}`,exact:true});
 const status=()=>page.getByRole('status');
 const waitStatus=async text=>{await page.waitForFunction(text=>document.getElementById('routingStatus').textContent.includes(text),text);};
 const login=async password=>{await page.getByRole('textbox',{name:'访问密码',exact:true}).fill(password);await button('登录').click();};
 try {
  await page.goto(origin+'/model-routing');
  assert.equal(await button('登录').isVisible(),true);
  await login('wrong-fixture');await waitStatus('登录失败');
  await login('panel-ui-fixture');await waitStatus('已加载全部路由');
  await button('＋ 新增路由').click();await field(1,'公开名称').fill('public-alpha');await field(1,'目标名称').fill('fixture-one');
  await page.getByRole('tab',{name:'Antigravity',exact:true}).click();
  await button('＋ 新增路由').click();await field(2,'公开名称').fill('public-beta');await field(2,'目标名称').fill('fixture-two');
  await page.getByRole('checkbox',{name:'启用第 2 行',exact:true}).uncheck();
  await page.getByRole('tab',{name:'Gemini CLI',exact:true}).click();assert.equal(await field(1,'公开名称').inputValue(),'public-alpha');
  await control({put_status:400});await button('保存全部路由').click();await waitStatus('保存未生效');
  assert.equal(await status().innerText(),'保存未生效。请修正校验错误，两个渠道的草稿均已保留。');
  assert.equal(await page.evaluate(()=>document.activeElement.id),'row-1-public_name');
  assert.equal(await page.getByRole('tab',{name:'Gemini CLI，1 个错误',exact:true}).isVisible(),true);
  assert.equal(await page.getByRole('tab',{name:'Antigravity，1 个错误',exact:true}).getAttribute('aria-selected'),'true');
  const saved=(await (await api.get('/_mock/state')).json()).puts.at(-1).routes;
  assert.deepEqual(saved,rows);
  await field(2,'公开名称').fill('public-beta-fixed');
  assert.equal(await page.getByRole('tab',{name:'Gemini CLI',exact:true}).isVisible(),true);
  const uncertain='保存结果无法确认，配置可能已经生效，请重新加载核对；草稿保留。';
  for(const code of [503,500,502,504]) {
    await control({put_status:code});await button('保存全部路由').click();await waitStatus('保存结果无法确认');
    assert.equal(await status().innerText(),uncertain);
    assert.equal(await field(2,'公开名称').inputValue(),'public-beta-fixed');assert.equal(await button('保存全部路由').isEnabled(),true);
    assert.equal(await page.locator('#draftState').getAttribute('data-dirty'),'true');
    assert.deepEqual((await (await api.get('/_mock/state')).json()).routes,[]);
  }
  await control({put_status:403});await button('保存全部路由').click();await waitStatus('登录已失效');
  assert.equal(await button('登录').isVisible(),true);
  await login('panel-ui-fixture');await waitStatus('原草稿已保留');assert.equal(await field(2,'公开名称').inputValue(),'public-beta-fixed');
  await control({put_status:200});await button('保存全部路由').click();await waitStatus('全部路由已保存');assert.equal(await button('保存全部路由').isEnabled(),false);
  await page.reload();await waitStatus('已加载全部路由');
  await field(1,'公开名称').fill('public-draft');
  await button('重新加载').click();await page.getByRole('dialog').waitFor({state:'visible'});
  await button('取消，保留草稿').click();assert.equal(await field(1,'公开名称').inputValue(),'public-draft');
  await page.getByRole('link',{name:'返回控制面板',exact:true}).click();await button('取消，保留草稿').click();assert.equal(page.url(),origin+'/model-routing');
  await button('重新加载').click();await button('确认丢弃').click();await waitStatus('已加载全部路由');assert.equal(await field(1,'公开名称').inputValue(),'public-alpha');
  await field(1,'公开名称').fill('public-draft');
  const dialogs=[];const onDialog=async dialog=>{dialogs.push(dialog.type());await dialog.dismiss();};page.on('dialog',onDialog);
  await page.reload({timeout:2000}).catch(error=>{if(!dialogs.includes('beforeunload'))throw error;});
  assert.equal(dialogs.includes('beforeunload'),true);assert.equal(await field(1,'公开名称').inputValue(),'public-draft');page.off('dialog',onDialog);
  await button('重新加载').click();await button('确认丢弃').click();await waitStatus('已加载全部路由');
  await page.screenshot({path:path.join(process.env.PANEL_UI_SCREENSHOTS,'model-routing-desktop.jpg'),type:'jpeg',fullPage:true});
  for(const width of [375,390]) {
    await page.setViewportSize({width,height:844});
    const geometry=await page.evaluate(()=>{
      const rect=document.getElementById('backToPanel').getBoundingClientRect();
      return {width:innerWidth,scroll:document.documentElement.scrollWidth,left:rect.left,right:rect.right};
    });
    assert.equal(geometry.width,width);assert.ok(geometry.scroll<=width);assert.ok(geometry.left>=0 && geometry.right<=width);
    assert.equal(await page.getByRole('link',{name:'返回控制面板',exact:true}).isVisible(),true);
    assert.equal(await button('保存全部路由').isVisible(),true);assert.equal(await button('重新加载').isVisible(),true);
  }
  await page.getByRole('tab',{name:'Antigravity',exact:true}).click();
  assert.ok((await page.locator('#channelHint').innerText()).includes('仅匹配完整名称；-search 不会自动联网。'));
  await page.screenshot({path:path.join(process.env.PANEL_UI_SCREENSHOTS,'model-routing-mobile.jpg'),type:'jpeg',fullPage:true});
  await control({routes:[{channel:'antigravity',public_name:7,upstream_name:'fixture-invalid',enabled:1,unknown:'invalid-field'}]});
  await button('重新加载').click();await waitStatus('已加载全部路由');assert.equal(await field(1,'公开名称').inputValue(),'7');
  await page.getByRole('button',{name:'删除第 1 行',exact:true}).click();await button('保存全部路由').click();await waitStatus('全部路由已保存');
  assert.deepEqual((await (await api.get('/_mock/state')).json()).puts.at(-1),{routes:[]});
  await button('退出登录').click();await control({get_status:503});await login('panel-ui-fixture');await waitStatus('配置暂时无法读取');
  await button('以空表修复配置').click();await button('确认丢弃').click();await button('保存全部路由').click();await waitStatus('全部路由已保存');
  await control({get_status:200,put_status:503,commit_before_error:true});
  await page.getByRole('tab',{name:'Gemini CLI',exact:true}).click();
  await button('＋ 新增路由').click();await field(1,'公开名称').fill('public-committed-cli');await field(1,'目标名称').fill('fixture-committed-cli');
  await page.getByRole('tab',{name:'Antigravity',exact:true}).click();
  await button('＋ 新增路由').click();await field(2,'公开名称').fill('public-committed-ag');await field(2,'目标名称').fill('fixture-committed-ag');
  await button('保存全部路由').click();await waitStatus('保存结果无法确认');
  const committedRows=[
    {channel:'geminicli',public_name:'public-committed-cli',upstream_name:'fixture-committed-cli',enabled:true},
    {channel:'antigravity',public_name:'public-committed-ag',upstream_name:'fixture-committed-ag',enabled:true}
  ];
  const committedState=await (await api.get('/_mock/state')).json();
  assert.deepEqual(committedState.puts.at(-1),{routes:committedRows});assert.deepEqual(committedState.routes,committedRows);
  assert.equal(await status().innerText(),uncertain);assert.equal(await button('保存全部路由').isEnabled(),true);
  assert.equal(await page.locator('#draftState').getAttribute('data-dirty'),'true');
  assert.equal(await field(2,'公开名称').inputValue(),'public-committed-ag');
  await page.screenshot({path:path.join(process.env.PANEL_UI_SCREENSHOTS,'model-routing-put503-uncertain.jpg'),type:'jpeg',fullPage:true});
  await field(2,'公开名称').fill('public-only-local');
  assert.deepEqual((await (await api.get('/_mock/state')).json()).routes,committedRows);
  await button('重新加载').click();await button('取消，保留草稿').click();assert.equal(await field(2,'公开名称').inputValue(),'public-only-local');
  await button('重新加载').click();await button('确认丢弃').click();await waitStatus('已加载全部路由');
  assert.equal(await field(2,'公开名称').inputValue(),'public-committed-ag');assert.equal(await field(2,'目标名称').inputValue(),'fixture-committed-ag');
  assert.equal(await button('保存全部路由').isEnabled(),false);assert.equal(await page.locator('#draftState').getAttribute('data-dirty'),'false');
  await page.getByRole('tab',{name:'Gemini CLI',exact:true}).click();assert.equal(await field(1,'公开名称').inputValue(),'public-committed-cli');
  await page.reload();await waitStatus('已加载全部路由');assert.equal(await field(1,'公开名称').inputValue(),'public-committed-cli');
  await page.screenshot({path:path.join(process.env.PANEL_UI_SCREENSHOTS,'model-routing-put503-reloaded.jpg'),type:'jpeg',fullPage:true});
  assert.equal(outbound.length,0);
  process.stdout.write(JSON.stringify({browser:'isolated Chrome headless',verified:['login','CLI/AG drafts','full PUT','400 related rows and focus','503/500/502/504 uncertain and draft preserve','403 re-login preserve','save success clears dirty','reload/leave cancel','reload discard','native beforeunload dismiss','375/390 width and header bounds','AG exact-name example','historical invalid/unknown row deletion repair','initial503 empty-table repair','PUT commit then503 uncertain','authoritative full table committed despite503','reload cancel retains local-only draft','reload discard confirms503 commit and clears dirty','page reload confirms503 committed CLI table'],external_requests:outbound.length,screenshots:process.env.PANEL_UI_SCREENSHOTS})+'\n');
 } finally {await context.close();await browser.close();await api.dispose();}
})().catch(error=>{console.error(error);process.exitCode=1;});
"""
    environment = dict(os.environ, PANEL_UI_PLAYWRIGHT=str(package), PANEL_UI_CHROME=str(chrome), PANEL_UI_SCREENSHOTS=output)
    result = subprocess.run([str(node), "-e", script], cwd=ROOT, env=environment, text=True, capture_output=True, timeout=60)
    print(result.stdout, end="")
    if result.returncode:
        print(result.stderr, end="")
        raise SystemExit(result.returncode)


if __name__ == "__main__":
    import sys
    if sys.argv[1:] == ["--browser-check"]:
        run_isolated_browser_check()
        raise SystemExit(0)
    if sys.argv[1:] != ["--serve"]:
        raise SystemExit("Use --serve for isolated local browser QA")
    # The only network permitted by this helper is local test traffic.
    _connect = socket.socket.connect

    def _loopback_only(sock, address):
        if not isinstance(address, tuple) or address[0] not in ("127.0.0.1", "::1", "localhost"):
            raise RuntimeError("External networking disabled in mock panel server")
        return _connect(sock, address)

    socket.socket.connect = _loopback_only
    import asyncio
    from hypercorn.asyncio import serve
    from hypercorn.config import Config

    server_config = Config()
    server_config.bind = ["127.0.0.1:18765"]
    server_config.accesslog = None
    server_config.errorlog = None
    asyncio.run(serve(create_mock_app(), server_config))
