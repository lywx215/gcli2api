# Docker 静态验证与后续实际门禁

日期：2026-10-13（Asia/Shanghai）。**静态配置核对已记录；Docker 实际构建、镜像与容器 smoke 均未验证。**

用户最新决定：先提交客户页面确认，确认后进入正式开发，详细测试留到正式开发阶段。
本记录不授权继续开发、修正 engines、测试、构建或部署；下文命令仅保存为未来参考。

## 范围与环境事实

只读检查集成工作区 `C:/Users/lywx2/.codex/worktrees/ui-redesign/gcli2api`，确认其 HEAD 为
`fe99b43a1b916f56f33d2f3b35aaf7c9eab6bbfd`，检查时工作区干净。记录在独立工作区的
`codex/ui-static-deployment-validation` 分支编写，基于该 SHA，不修改主集成工作区。

初次 `docker version` 返回 Docker CLI 29.7.2、API 1.55、windows/amd64、context
`desktop-linux`，daemon 连接失败原因为：

```text
failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine; check if the path is correct and if the daemon is running: open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.
```

曾依前一条授权发起 `docker desktop start --timeout 50`，等待期间收到用户最新指示：当前环境
无法构建，立即停止构建/启动/安装。已向该命令发送 Ctrl+C，返回 exit code 1、无输出。
之后不再探测或改变 daemon 状态，不声称其最终状态已核实，也没有停止无关服务。

没有执行 docker build、docker run、安装、重启、部署或 push；没有创建实际构建上下文或
验证容器，没有修改已有容器、Volume、真实环境、凭证或数据库。最终镜像标签/ID/digest
**未产生**；实际容器平台、Node/npm/Python 版本**未验证**。下文 linux/amd64 是后续目标，
不是已完成的平台证据。环境限制由用户明确告知，不能以静态检查代替实际 Docker 门禁。

## 已完成证据

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

### Node engines：待客户确认后的开发建议

主集成 fe99b43 的 package 根 engines 及 lock 根 engines 仍为
`^22.12.0 || ^24.0.0 || >=26.0.0`。锁内 @asamuzakjp/css-color、
@asamuzakjp/dom-selector、jsdom、w3c-xmlserializer 等要求
`^22.22.2 || ^24.15.0 || >=26.0.0`，严于现有根级下限。
建议在客户确认后的正式开发阶段，将 package 与 lock 根 engines 同步收紧到实际交集，
同时更新源码安装说明；不要重新解析或升级依赖。此建议当前**未集成、未验收**。

收到最新停止指示前，独立分支已经修改以下三个文件；现全部保留为未提交候选草稿，
不纳入本记录的文档提交，也不得 cherry-pick 到主 UI 分支：

- `frontend/package.json`：拟收紧根 engines.node。
- `frontend/package-lock.json`：拟收紧 packages[""].engines.node。
- `docs/UI_STATIC_DEPLOYMENT.md`：拟同步最低 Node 版本。

当时使用宿主 Node **24.19.0** 的 semver 检查通过，满足候选范围及锁文件全部 Node engines。
但原始字节等价断言未通过，未继续归因，也未完成候选元数据的全部等价确认；不能宣称
该候选已验证无其他差异。用户收紧流程后没有继续修改候选或新增测试。

`node:22-bookworm-slim` 保持原样，其实际 Node 版本、digest、拉取可用性及 Linux
原生依赖安装仍未验证。未来正式开发和实际构建应确认 Node 22 至少 22.22.2。

## 后续完整构建命令（全部尚未执行）

须客户确认并进入正式开发、具备可用 Docker 环境后才执行；现在不运行。不包含启动引擎或环境绕行。以下 PowerShell 从精确 commit 的
Git archive 建立新临时目录，不复制工作树真实配置。示例固定 fe99b43 用于复现此次静态检查；
验证最终收尾版本时，将 revision 显式替换为合入 engines 修正后的完整集成 SHA，并记录该 SHA。

```powershell
$repo = 'C:/Users/lywx2/.codex/worktrees/ui-redesign/gcli2api'
$revision = 'fe99b43a1b916f56f33d2f3b35aaf7c9eab6bbfd'
$validationRoot = Join-Path ([IO.Path]::GetTempPath()) ('gcli-ui-docker-' + [guid]::NewGuid().ToString('N'))
$context = Join-Path $validationRoot 'context'
New-Item -ItemType Directory -Path $context -Force | Out-Null
$archive = Join-Path $validationRoot 'source.tar'
git -C $repo archive --format=tar --output=$archive $revision
if ($LASTEXITCODE -ne 0) { throw 'git archive failed' }
tar -xf $archive -C $context
if ($LASTEXITCODE -ne 0) { throw 'archive extraction failed' }
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
