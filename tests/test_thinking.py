import requests
import json

url = "http://127.0.0.1:7861/v1/chat/completions"
headers = {"Content-Type": "application/json", "Authorization": "Bearer pwd"}

# === Non-Streaming Request ===
payload = {
    "model": "gemini-2.5-flash",
    "messages": [{"role": "user", "content": "1+1=?"}],
    "stream": False
}

print("=" * 60)
print("NON-STREAMING REQUEST (stream=false)")
print("=" * 60)
try:
    r = requests.post(url, json=payload, headers=headers, timeout=120)
    print("Status:", r.status_code)
    data = r.json()
    for i, choice in enumerate(data.get("choices", [])):
        msg = choice.get("message", {})
        print("Choice", i, ":")
        print("  role:", msg.get("role"))
        content = msg.get("content", "")
        print("  content:", content[:200] if content else "None")
        has_reasoning = "reasoning_content" in msg
        print("  has reasoning_content:", has_reasoning)
        if has_reasoning:
            rc = msg["reasoning_content"]
            print("  reasoning_content length:", len(rc))
            print("  reasoning_content preview:", rc[:500], "...")
        print("  finish_reason:", choice.get("finish_reason"))
    print()
    print("Message keys:", list(data.get("choices", [{}])[0].get("message", {}).keys()))
except Exception as e:
    print("Error:", e)

print()
print()

# === Streaming Request ===
payload["stream"] = True

print("=" * 60)
print("STREAMING REQUEST (stream=true)")
print("=" * 60)
try:
    r = requests.post(url, json=payload, headers=headers, timeout=120, stream=True)
    print("Status:", r.status_code)
    
    reasoning_chunks = []
    content_chunks = []
    all_delta_keys = set()
    chunk_count = 0
    
    for line in r.iter_lines():
        if not line:
            continue
        line_str = line.decode("utf-8")
        if not line_str.startswith("data: "):
            continue
        json_str = line_str[6:]
        if json_str.strip() == "[DONE]":
            print("[DONE]")
            break
        try:
            chunk = json.loads(json_str)
            chunk_count += 1
            for choice in chunk.get("choices", []):
                delta = choice.get("delta", {})
                all_delta_keys.update(delta.keys())
                if "reasoning_content" in delta:
                    reasoning_chunks.append(delta["reasoning_content"])
                if "content" in delta:
                    content_chunks.append(delta["content"])
                if choice.get("finish_reason"):
                    print("  finish_reason:", choice["finish_reason"])
        except json.JSONDecodeError:
            pass
    
    print()
    print("Total chunks:", chunk_count)
    print("All delta keys seen:", all_delta_keys)
    print("Has reasoning_content in stream:", len(reasoning_chunks) > 0)
    print("Reasoning chunks count:", len(reasoning_chunks))
    if reasoning_chunks:
        full_reasoning = "".join(reasoning_chunks)
        print("Full reasoning length:", len(full_reasoning))
        print("Reasoning preview:", full_reasoning[:500], "...")
    print()
    full_content = "".join(content_chunks)
    print("Content:", full_content[:200])
except Exception as e:
    print("Error:", e)
