"""
Gemini CLI 直连测试工具
直接读取凭证文件, 刷新 OAuth token, 请求 GeminiCLI v1internal 端点

用法:
    python tests/test_geminicli_direct.py                          # 使用默认 creds 目录第一个文件
    python tests/test_geminicli_direct.py --cred path/to/cred.json # 指定凭证文件
    python tests/test_geminicli_direct.py --model gemini-2.5-flash # 指定模型
    python tests/test_geminicli_direct.py --stream                 # 流式请求
    python tests/test_geminicli_direct.py --prompt "你好"           # 自定义 prompt
    python tests/test_geminicli_direct.py --endpoint https://...   # 自定义 endpoint
"""

import argparse
import asyncio
import glob
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone

import httpx

# ==================== 常量 ====================

DEFAULT_ENDPOINT = "https://cloudcode-pa.googleapis.com"
OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token"
USER_AGENT = "GeminiCLI/0.1.5 (Windows; AMD64)"
DEFAULT_MODEL = "gemini-3.1-pro-preview"
DEFAULT_PROMPT = "1+1=? 请用一句话回答。"

# 项目根目录
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


# ==================== 凭证管理 ====================

def find_first_credential(creds_dir: str = None) -> str:
    """在 creds 目录中找到第一个 JSON 凭证文件"""
    if creds_dir is None:
        creds_dir = os.path.join(PROJECT_ROOT, "creds")

    if not os.path.isdir(creds_dir):
        print(f"❌ 凭证目录不存在: {creds_dir}")
        sys.exit(1)

    json_files = sorted(glob.glob(os.path.join(creds_dir, "*.json")))
    if not json_files:
        print(f"❌ 凭证目录中没有 JSON 文件: {creds_dir}")
        sys.exit(1)

    return json_files[0]


def load_credential(filepath: str) -> dict:
    """加载凭证 JSON 文件"""
    with open(filepath, "r", encoding="utf-8") as f:
        data = json.load(f)
    print(f"✅ 已加载凭证: {os.path.basename(filepath)}")

    # 显示凭证基本信息
    token = data.get("token") or data.get("access_token", "")
    project_id = data.get("project_id", "")
    refresh_token = data.get("refresh_token", "")
    client_id = data.get("client_id", "")
    expiry = data.get("expiry", "")

    print(f"   project_id: {project_id or '(无)'}")
    print(f"   token: {token[:20]}...{token[-10:]}" if len(token) > 30 else f"   token: {token or '(无)'}")
    print(f"   refresh_token: {'✅ 有' if refresh_token else '❌ 无'}")
    print(f"   client_id: {'✅ 有' if client_id else '❌ 无'}")
    print(f"   expiry: {expiry or '(无)'}")

    return data


async def refresh_token(cred_data: dict) -> str:
    """使用 refresh_token 刷新 access_token"""
    refresh_tok = cred_data.get("refresh_token", "")
    client_id = cred_data.get("client_id", "")
    client_secret = cred_data.get("client_secret", "")

    if not refresh_tok:
        # 没有 refresh_token, 尝试直接使用现有 token
        token = cred_data.get("token") or cred_data.get("access_token", "")
        if token:
            print("⚠️  没有 refresh_token, 将直接使用现有 token (可能已过期)")
            return token
        print("❌ 既没有 refresh_token 也没有 access_token")
        sys.exit(1)

    print("🔄 正在刷新 access_token...")

    data = {
        "client_id": client_id,
        "client_secret": client_secret,
        "refresh_token": refresh_tok,
        "grant_type": "refresh_token",
    }

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            OAUTH_TOKEN_URL,
            data=data,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )

    if resp.status_code != 200:
        print(f"❌ Token 刷新失败: HTTP {resp.status_code}")
        print(f"   响应: {resp.text[:500]}")
        sys.exit(1)

    token_data = resp.json()
    new_token = token_data["access_token"]
    expires_in = token_data.get("expires_in", 0)

    print(f"✅ Token 刷新成功, 有效期: {expires_in}s")
    print(f"   new_token: {new_token[:20]}...{new_token[-10:]}")

    return new_token


# ==================== 请求构建 ====================

def build_payload(model: str, project_id: str, prompt: str) -> dict:
    """构建 GeminiCLI v1internal 请求 payload"""
    return {
        "model": model,
        "project": project_id,
        "request": {
            "contents": [
                {
                    "role": "user",
                    "parts": [{"text": prompt}]
                }
            ],
            "generationConfig": {
                "temperature": 1.0,
                "topP": 0.95,
                "topK": 40,
            }
        }
    }


def build_headers(token: str) -> dict:
    """构建请求头"""
    return {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
    }


# ==================== 非流式请求 ====================

async def non_stream_request(
    endpoint: str, token: str, model: str,
    project_id: str, prompt: str, proxy: str = None
):
    """发送非流式请求"""
    url = f"{endpoint.rstrip('/')}/v1internal:generateContent"
    headers = build_headers(token)
    payload = build_payload(model, project_id, prompt)

    print(f"\n{'=' * 70}")
    print(f"📤 NON-STREAM REQUEST")
    print(f"{'=' * 70}")
    print(f"URL: {url}")
    print(f"Model: {model}")
    print(f"Project: {project_id}")
    print(f"Prompt: {prompt}")
    print()

    start_time = time.time()

    client_kwargs = {"timeout": 120, "verify": False}
    if proxy:
        client_kwargs["proxies"] = proxy
    async with httpx.AsyncClient(**client_kwargs) as client:
        resp = await client.post(url, json=payload, headers=headers)

    elapsed = time.time() - start_time

    print(f"⏱️  耗时: {elapsed:.2f}s")
    print(f"📥 HTTP Status: {resp.status_code}")
    print(f"📥 Content-Type: {resp.headers.get('content-type', 'N/A')}")
    print()

    if resp.status_code != 200:
        print(f"❌ 错误响应:")
        try:
            error_data = resp.json()
            print(json.dumps(error_data, indent=2, ensure_ascii=False))
        except Exception:
            print(resp.text[:1000])
        return

    try:
        data = resp.json()

        # 检查是否有 response 包装
        if "response" in data:
            data = data["response"]

        # 提取 candidates
        candidates = data.get("candidates", [])
        if not candidates:
            print("⚠️  没有 candidates")
            print(json.dumps(data, indent=2, ensure_ascii=False)[:2000])
            return

        for i, candidate in enumerate(candidates):
            parts = candidate.get("content", {}).get("parts", [])
            finish_reason = candidate.get("finishReason", "N/A")

            print(f"--- Candidate {i} (finishReason: {finish_reason}) ---")

            for j, part in enumerate(parts):
                if part.get("thought"):
                    text = part.get("text", "")
                    print(f"  🧠 Thought Part [{j}] ({len(text)} chars):")
                    print(f"     {text[:300]}{'...' if len(text) > 300 else ''}")
                elif "text" in part:
                    text = part["text"]
                    print(f"  📝 Text Part [{j}] ({len(text)} chars):")
                    print(f"     {text[:500]}{'...' if len(text) > 500 else ''}")
                elif "executableCode" in part:
                    code = part["executableCode"]
                    print(f"  💻 Code Part [{j}] ({code.get('language', 'unknown')}):")
                    print(f"     {code.get('code', '')[:200]}")
                else:
                    print(f"  📦 Other Part [{j}]: {list(part.keys())}")

        # 显示 usage
        usage = data.get("usageMetadata", {})
        if usage:
            print(f"\n📊 Usage:")
            print(f"   promptTokenCount: {usage.get('promptTokenCount', 'N/A')}")
            print(f"   candidatesTokenCount: {usage.get('candidatesTokenCount', 'N/A')}")
            print(f"   totalTokenCount: {usage.get('totalTokenCount', 'N/A')}")
            thoughts = usage.get("thoughtsTokenCount")
            if thoughts:
                print(f"   thoughtsTokenCount: {thoughts}")

    except Exception as e:
        print(f"❌ 解析响应失败: {e}")
        print(resp.text[:2000])


# ==================== 流式请求 ====================

async def stream_request(
    endpoint: str, token: str, model: str,
    project_id: str, prompt: str, proxy: str = None
):
    """发送流式请求"""
    url = f"{endpoint.rstrip('/')}/v1internal:streamGenerateContent?alt=sse"
    headers = build_headers(token)
    payload = build_payload(model, project_id, prompt)

    print(f"\n{'=' * 70}")
    print(f"📤 STREAM REQUEST")
    print(f"{'=' * 70}")
    print(f"URL: {url}")
    print(f"Model: {model}")
    print(f"Project: {project_id}")
    print(f"Prompt: {prompt}")
    print()

    start_time = time.time()
    chunk_count = 0
    text_parts = []
    thought_parts = []
    first_chunk_time = None
    last_usage = None

    client_kwargs = {"timeout": httpx.Timeout(120, connect=30), "verify": False}
    if proxy:
        client_kwargs["proxies"] = proxy
    async with httpx.AsyncClient(**client_kwargs) as client:
        async with client.stream("POST", url, json=payload, headers=headers) as resp:
            print(f"📥 HTTP Status: {resp.status_code}")
            print(f"📥 Content-Type: {resp.headers.get('content-type', 'N/A')}")
            print()

            if resp.status_code != 200:
                body = await resp.aread()
                print(f"❌ 错误响应:")
                try:
                    print(json.dumps(json.loads(body), indent=2, ensure_ascii=False))
                except Exception:
                    print(body.decode("utf-8", errors="replace")[:1000])
                return

            buffer = ""
            async for raw_chunk in resp.aiter_text():
                buffer += raw_chunk
                while "\n" in buffer:
                    line, buffer = buffer.split("\n", 1)
                    line = line.strip()

                    if not line:
                        continue

                    if not line.startswith("data: "):
                        continue

                    json_str = line[6:]
                    if json_str == "[DONE]":
                        print("\n[DONE]")
                        continue

                    try:
                        data = json.loads(json_str)
                    except json.JSONDecodeError:
                        print(f"  ⚠️ JSON 解析失败: {json_str[:100]}")
                        continue

                    chunk_count += 1
                    if chunk_count == 1:
                        first_chunk_time = time.time() - start_time

                    # 解包装 response
                    if "response" in data and "candidates" not in data:
                        data = data["response"]

                    # 提取内容
                    candidates = data.get("candidates", [])
                    for candidate in candidates:
                        parts = candidate.get("content", {}).get("parts", [])
                        finish_reason = candidate.get("finishReason")

                        for part in parts:
                            if part.get("thought") and "text" in part:
                                thought_parts.append(part["text"])
                                print("🧠", end="", flush=True)
                            elif "text" in part:
                                text_parts.append(part["text"])
                                print(".", end="", flush=True)

                        if finish_reason and finish_reason != "STOP":
                            print(f" [finishReason: {finish_reason}]", end="")

                    # 记录 usage
                    usage = data.get("usageMetadata")
                    if usage:
                        last_usage = usage

    elapsed = time.time() - start_time
    print()

    # 汇总
    print(f"\n{'─' * 50}")
    print(f"📊 流式请求汇总:")
    print(f"   总耗时: {elapsed:.2f}s")
    print(f"   首 chunk: {first_chunk_time:.2f}s" if first_chunk_time else "   首 chunk: N/A")
    print(f"   chunk 数: {chunk_count}")
    print(f"   思维链: {'✅ 有' if thought_parts else '❌ 无'} ({len(thought_parts)} chunks)")

    if thought_parts:
        full_thought = "".join(thought_parts)
        print(f"   思维链长度: {len(full_thought)} chars")
        print(f"   思维链预览: {full_thought[:300]}{'...' if len(full_thought) > 300 else ''}")

    full_text = "".join(text_parts)
    print(f"   回答长度: {len(full_text)} chars")
    print(f"   回答内容: {full_text[:500]}{'...' if len(full_text) > 500 else ''}")

    if last_usage:
        print(f"\n📊 Usage:")
        print(f"   promptTokenCount: {last_usage.get('promptTokenCount', 'N/A')}")
        print(f"   candidatesTokenCount: {last_usage.get('candidatesTokenCount', 'N/A')}")
        print(f"   totalTokenCount: {last_usage.get('totalTokenCount', 'N/A')}")
        thoughts = last_usage.get("thoughtsTokenCount")
        if thoughts:
            print(f"   thoughtsTokenCount: {thoughts}")


# ==================== 主入口 ====================

async def main():
    parser = argparse.ArgumentParser(description="GeminiCLI 直连测试工具")
    parser.add_argument("--cred", type=str, help="凭证 JSON 文件路径 (默认取 creds/ 第一个)")
    parser.add_argument("--creds-dir", type=str, help="凭证目录 (默认 creds/)")
    parser.add_argument("--model", type=str, default=DEFAULT_MODEL, help=f"模型名称 (默认 {DEFAULT_MODEL})")
    parser.add_argument("--prompt", type=str, default=DEFAULT_PROMPT, help="提示词")
    parser.add_argument("--stream", action="store_true", help="使用流式请求")
    parser.add_argument("--both", action="store_true", help="同时测试流式和非流式")
    parser.add_argument("--endpoint", type=str, default=DEFAULT_ENDPOINT,
                        help=f"API Endpoint (默认 {DEFAULT_ENDPOINT})")
    parser.add_argument("--proxy", type=str, default=None, help="HTTP 代理 (例如 http://127.0.0.1:7890)")
    parser.add_argument("--no-refresh", action="store_true", help="跳过 token 刷新, 直接使用现有 token")

    args = parser.parse_args()

    print("=" * 70)
    print("🔧 GeminiCLI 直连测试工具")
    print("=" * 70)
    print()

    # 1. 加载凭证
    if args.cred:
        cred_file = args.cred
    else:
        cred_file = find_first_credential(args.creds_dir)

    cred_data = load_credential(cred_file)

    # 2. 刷新 token
    if args.no_refresh:
        token = cred_data.get("token") or cred_data.get("access_token", "")
        if not token:
            print("❌ 没有可用的 token")
            sys.exit(1)
        print("⏭️  跳过 token 刷新")
    else:
        token = await refresh_token(cred_data)

    # 3. 获取 project_id
    project_id = cred_data.get("project_id", "")
    if not project_id:
        print("❌ 凭证中没有 project_id")
        sys.exit(1)

    print(f"\n📋 测试参数:")
    print(f"   Endpoint: {args.endpoint}")
    print(f"   Model: {args.model}")
    print(f"   Proxy: {args.proxy or '(无)'}")
    print(f"   Project: {project_id}")

    # 4. 发送请求
    if args.both:
        await non_stream_request(
            args.endpoint, token, args.model, project_id, args.prompt, args.proxy
        )
        print("\n\n")
        await stream_request(
            args.endpoint, token, args.model, project_id, args.prompt, args.proxy
        )
    elif args.stream:
        await stream_request(
            args.endpoint, token, args.model, project_id, args.prompt, args.proxy
        )
    else:
        await non_stream_request(
            args.endpoint, token, args.model, project_id, args.prompt, args.proxy
        )

    print(f"\n{'=' * 70}")
    print("✅ 测试完成")
    print(f"{'=' * 70}")


if __name__ == "__main__":
    asyncio.run(main())
