# Docker 静态验证与后续实际门禁

日期：2026-10-13（Asia/Shanghai）。**Node engines 兼容修正及 Windows 本地构建已验证；Docker 实际构建、镜像与容器 smoke 均未验证。**

用户已确认方案并正式恢复开发与开发阶段测试；本次仅收紧两处根 engines 元数据并更新构建说明。
Docker 当前环境仍不可构建，禁止启动引擎、安装或环境绕行；Docker 命令仅供未来环境可用时参考，
不构成当前部署、推送或生产访问授权。

## 范围与环境事实

本轮正式基线为 `419873f42ed0b82ef1997ea25edef940342ce500`，来自 `codex/ui-redesign`。
独立分支为 `codex/ui-formal-build-compat`，工作区为
`C:/Users/lywx2/.codex/worktrees/ui-formal-build-compat/gcli2api`。主集成工作区仅只读确认，
其已有未提交改动未复制、未修改。正式源码完整来自该基线，不从旧分支补共享实现。

下方 Docker CLI/daemon 记录来自前轮 fe99b43 检查；本轮没有重新调用 Docker。

初次 `docker version` 返回 Docker CLI 29.7.2、API 1.55、windows/amd64、context
`desktop-linux`，daemon 连接失败原因为：

```text
failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine; check if the path is correct and if the daemon is running: open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.
```

曾依前一条授权发起 `docker desktop start --timeout 50`，等待期间收到用户最新指示：当前环境
无法构建，立即停止构建/启动/安装。已向该命令发送 Ctrl+C，返回 exit code 1、无输出。
之后不再探测或改变 daemon 状态，不声称其最终状态已核实，也没有停止无关服务。

没有执行 docker build、docker run、Docker/系统安装、重启、部署或 push；没有创建实际构建上下文或
验证容器，没有修改已有容器、Volume、真实环境、凭证或数据库。最终镜像标签/ID/digest
**未产生**；实际容器平台、Node/npm/Python 版本**未验证**。下文 linux/amd64 是后续目标，
不是已完成的平台证据。环境限制由用户明确告知，不能以静态检查代替实际 Docker 门禁。

## 前轮静态与局部测试证据

- fe99b43 的 Dockerfile、.dockerignore、web.py、src/panel/ui.py、src/panel/root.py
  与已交付 `57f050b236ff9f583b5af36c44ef57a80685041f` 的对应 Git blob 相同。
- 前端阶段为 `node:22-bookworm-slim`；在 `/build/frontend` 先复制 manifest/lock 并
  `npm ci`，再复制源码，执行 typecheck、build、check:build。最终 Python 阶段从该阶段
  复制 `/build/ui-dist` 到 `/app/ui-dist`，不继承 Node 阶段。实际运行时仍需容器验证。
- Vite `base: './'`、`outDir: '../ui-dist'` 与镜像复制路径相符。最终阶段保留旧 panel、
  模型 API routers 与 `/front` 挂载；旧根、`/model-routing` 与动态 HTML/CSP 代码未变。
- package 与 lock 根 dependencies/devDependencies/engines 一致，lockfileVersion 为 3；
  Docker 使用的 scripts 存在。check-build 检查五个独立页面 dynamic entry、manifest
  全部依赖文件、hash JS/CSS、相对路径、meta 注入点及无 DEV fixture 标记。
  这是检查代码已接线的证据，不表示在 Docker 内执行通过。
- `.dockerignore` 的 creds/credentials/data 为根目录规则，保留 credentials 业务源码目录；
  精确放行工程 JSON/lock，排除环境、凭证、数据库、依赖和本地产物。前轮 Moby 原生匹配器
  已验证 17 个保留路径和 14 个排除路径；规则未变，本次没有重复该检查。
- 前轮 77 项 Python 与 29 项旧面板 JS 检查通过，均非此次容器内执行。完整旧模型矩阵由
  主集成聊天独立归因；本记录不替其下结论。风格调整不在本轮范围。

## 本轮正式构建兼容验证

基线 package 根 engines 及 lock 根 engines 原为 `^22.12.0 || ^24.0.0 || >=26.0.0`。
锁内 @asamuzakjp/css-color、@asamuzakjp/dom-selector、jsdom、w3c-xmlserializer 等要求
`^22.22.2 || ^24.15.0 || >=26.0.0`。本轮只将 `frontend/package.json` 的 engines.node
和 `frontend/package-lock.json` 的 packages[""].engines.node 同步收紧到后者，
并更新源码安装说明；没有重新解析依赖、升级版本或修改 integrity。

相对正式基线的 JSON 语义比较通过：恢复这两个根级字段的旧值后，两个完整 JSON 对象均与
基线完全相等。去除 CRLF/LF 表示差异后的字节比较也通过，只有每个文件的一处 engines 替换；
保留 checkout 原有行尾（package 57 个 CRLF，lock 4079 个 CRLF）。npm ci 后再次核对相同约束。

本机 Windows/amd64、Node **24.19.0**、npm **11.17.0** 的实际执行结果：

| 检查/命令（仓库根） | 结果 |
| --- | --- |
| npm bundled semver 检查本机 Node 与全部 locked Node engines | 项目范围及全部 133 条约束通过 |
| `npm --prefix frontend ci --no-audit --no-fund` | 通过，安装 185 个包；依照锁文件安装，未执行依赖升级或漏洞审计 |
| `npm --prefix frontend run typecheck` | 通过 |
| `npm --prefix frontend run build` | 通过，Vite 8.3.4；2119 个模块；独立 ui-dist 产物 |
| `npm --prefix frontend run check:build` | 通过：8 个 hash JS、1 个 hash CSS、五个独立页面、完整 manifest 引用、meta 注入点、无 DEV fixture 标记 |

本窗口不重复主窗口负责的完整前端单元测试。构建只使用源码及锁定依赖，不启动真实 Python
lifespan，不调用模型、OAuth、凭证或生产 API；产物与 node_modules 保持忽略，不纳入提交。
这仅证明 Windows 宿主的安装、类型检查与生产构建，不证明 Linux 原生依赖或 Docker 镜像通过。

### 上轮草稿与字节断言的归因

旧工作区 `C:/Users/lywx2/.codex/worktrees/ui-static-deployment/gcli2api` 的
`codex/ui-static-deployment-validation` 分支仍保留三份未提交草稿：package、lock 及
`docs/UI_STATIC_DEPLOYMENT.md`。本轮只读比对，没有修改、reset、删除或移动旧草稿。
上轮字节断言把 CRLF checkout 与 LF Git blob 直接比较，因行尾表示不同失败；本轮确认旧草稿
统一行尾后，除了原先拟定的单处根 engines 替换，其他字节无差异。正式实现仍从 419873f
独立完成，不依赖旧草稿作为源码基线。

`node:22-bookworm-slim` 保持原样。实际镜像 Node/npm 版本、digest、拉取可用性及 Linux
依赖安装仍未验证；未来实际构建应确认 Node 22 至少 22.22.2，不把本机结果当作镜像证据。

## 后续完整构建命令（全部尚未执行）

仅在之后允许实际 Docker 验证、且环境可用时执行；当前禁止运行，不包含启动引擎或环境绕行。
以下 PowerShell 一次解析 `codex/ui-redesign` 为完整 SHA，然后固定该 SHA 创建 Git archive，
不复制工作树真实配置。先确认主分支已集成 engines 修正，再运行；命令会检查归档 manifest
的范围并记录完整 SHA，防止拿未集成版本代替验收。

```powershell
$repo = 'C:/Users/lywx2/.codex/worktrees/ui-redesign/gcli2api'
$revision = (git -C $repo rev-parse --verify 'codex/ui-redesign^{commit}').Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve integration commit' }
Write-Output "Frozen source revision: $revision"
$validationRoot = Join-Path ([IO.Path]::GetTempPath()) ('gcli-ui-docker-' + [guid]::NewGuid().ToString('N'))
$context = Join-Path $validationRoot 'context'
New-Item -ItemType Directory -Path $context -Force | Out-Null
$archive = Join-Path $validationRoot 'source.tar'
git -C $repo archive --format=tar --output=$archive $revision
if ($LASTEXITCODE -ne 0) { throw 'git archive failed' }
tar -xf $archive -C $context
if ($LASTEXITCODE -ne 0) { throw 'archive extraction failed' }
$archivedPackage = Get-Content -Raw (Join-Path $context 'frontend/package.json') | ConvertFrom-Json
if ($archivedPackage.engines.node -ne '^22.22.2 || ^24.15.0 || >=26.0.0') { throw 'Engine correction is not integrated' }
$image = 'gcli2api:ui-verify-' + $revision.Substring(0,12)
$builderImage = 'gcli2api:ui-builder-verify-' + $revision.Substring(0,12)
$iidFile = Join-Path $validationRoot 'image-id.txt'
docker version
docker build --pull --progress=plain --platform linux/amd64 --build-arg "REVISION=$revision" --build-arg SOURCE_REF=codex/ui-redesign --tag $image --iidfile $iidFile $context 2>&1 | Tee-Object (Join-Path $validationRoot 'build.log')
if ($LASTEXITCODE -ne 0) { throw 'Build failed; preserve actual log, do not run smoke' }
docker image inspect --format '{{.Id}} {{.Os}}/{{.Architecture}} {{json .RepoDigests}}' $image
if ($LASTEXITCODE -ne 0) { throw 'Image inspect failed' }
docker build --progress=plain --platform linux/amd64 --target ui-build --tag $builderImage $context 2>&1 | Tee-Object (Join-Path $validationRoot 'builder.log')
if ($LASTEXITCODE -ne 0) { throw 'Builder stage failed' }
docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --entrypoint node $builderImage -e 'const v=process.versions.node.split(".").map(Number); console.log(process.versions.node); if(v[0]!==22 || v[1]<22 || (v[1]===22 && v[2]<2)) process.exit(1)'
if ($LASTEXITCODE -ne 0) { throw 'Node 22.22.2+ check failed' }
docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --entrypoint npm $builderImage --version
if ($LASTEXITCODE -ne 0) { throw 'npm version check failed' }
```

记录完整 build 日志中的 npm ci/typecheck/Vite/五页分块校验和最终镜像导出成功信息、
实际 Node/npm 版本、基础镜像 digest、最终镜像 ID 及 OS/architecture。
本地镜像 RepoDigests 为空不等于构建失败。不要把不同版本或未实际执行的结果记为通过。

## 最终镜像安全 smoke（尚未执行）

续用上面变量。新容器使用 network none、无端口映射、无 bind mount/持久 Volume、只读根、
非特权用户及临时 /tmp。httpx ASGITransport 直接调用内存应用，不启动监听或真实 lifespan；
只读取静态入口，不调用模型、OAuth 或数据库。Python-only 也在容器中验证。

```powershell
$smoke = @'
import asyncio
from contextlib import asynccontextmanager
import json
from pathlib import Path
import platform
import shutil
import httpx
import config
config._config_initialized = True
config._config_cache = {config.GCLI_EMBED_MODE_KEY: "disabled"}
synthetic = Path("/tmp/ui-smoke-credentials")
synthetic.mkdir()
assert not any(synthetic.iterdir())
assert shutil.which("node") is None and shutil.which("npm") is None
for path in ("/app/frontend/node_modules", "/app/.env", "/app/creds"):
    assert not Path(path).exists(), path
import web
@asynccontextmanager
async def forbidden_lifespan(app):
    raise AssertionError("Real lifespan must not run")
    yield
web.app.router.lifespan_context = forbidden_lifespan
async def main():
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=web.app), base_url="http://fixture.invalid") as client:
        for path in ("/", "/model-routing", "/front/common.js", "/ui/"):
            response = await client.get(path)
            assert response.status_code == 200, (path, response.status_code)
        response = await client.get("/ui/")
        assert response.headers["cache-control"] == "no-store"
        assert response.headers["content-security-policy"] == "frame-ancestors 'none'"
        assert "__GCLI_" not in response.text
        assert 'name="gcli-service-base" content="/"' in response.text
        redirect = await client.get("/ui?fixture=1", follow_redirects=False)
        assert redirect.status_code == 307
        assert redirect.headers["location"] == "/ui/?fixture=1"
        manifest = json.loads(Path("/app/ui-dist/.vite/manifest.json").read_text())
        pages = [manifest[f"src/pages/{name}/index.tsx"] for name in ("overview", "credentials", "import", "settings", "logs")]
        assert all(page["isDynamicEntry"] for page in pages)
        assert len({page["file"] for page in pages}) == 5
        files = {item["file"] for item in manifest.values()}
        files.update(file for item in manifest.values() for file in item.get("css", []))
        for file in sorted(files):
            response = await client.get("/ui/" + file)
            assert response.status_code == 200, file
            assert "immutable" in response.headers["cache-control"], file
            if file.endswith(".js"):
                assert response.headers["content-type"].split(";")[0] == "text/javascript"
            if file.endswith(".css"):
                assert response.headers["content-type"].split(";")[0] == "text/css"
        for path in ("/ui/index.html", "/ui/.vite/manifest.json", "/ui/assets/missing.js"):
            assert (await client.get(path)).status_code == 404, path
    assert not any(synthetic.iterdir())
    print(json.dumps({"result": "passed", "python": platform.python_version(), "machine": platform.machine(), "asset_count": len(files), "independent_pages": 5, "node_present": False, "lifespan": "not run"}))
asyncio.run(main())
'@
$smoke | docker run --rm -i --network none --read-only --tmpfs /tmp:rw,nosuid,nodev,size=16m --cap-drop ALL --security-opt no-new-privileges --user 65534:65534 --env ENABLE_LOG=0 --env CREDENTIALS_DIR=/tmp/ui-smoke-credentials --entrypoint python $image - 2>&1 | Tee-Object (Join-Path $validationRoot 'smoke.log')
if ($LASTEXITCODE -ne 0) { throw 'Container smoke failed' }
```

容器结束自动删除，本地验证镜像和临时日志保留用于追溯。不执行 prune、系统重启或生产动作。
只有未来完整 build、smoke 实际成功并补齐证据后，才能更新实际 Docker 门禁状态。
