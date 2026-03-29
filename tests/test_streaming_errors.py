import requests
import json
import time

def test_streaming_error_handling(base_url="http://127.0.0.1:7861", token="pwd"):
    """
    Test that the server correctly returns HTTP error status codes (e.g., 500 or 503)
    instead of HTTP 200 when an error occurs during a streaming request.
    """
    print("=" * 60)
    print("🧪 Testing Streaming Error Handling")
    print("=" * 60)
    
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {token}"
    }

    endpoints = {
        "OpenAI Router (/v1/chat/completions)": {
            "url": f"{base_url}/v1/chat/completions",
            "payload": {
                "model": "gemini-2.5-flash",
                "messages": [{"role": "user", "content": "How are you?"}],
                "stream": True
            }
        },
        "Anthropic Router (/v1/messages)": {
            "url": f"{base_url}/v1/messages",
            "payload": {
                "model": "gemini-2.5-flash",
                "max_tokens": 1024,
                "messages": [{"role": "user", "content": "How are you?"}],
                "stream": True
            }
        }
    }

    for name, config in endpoints.items():
        print(f"\n[{name}]")
        print(f"👉 POST {config['url']}")
        
        try:
            # We use stream=True so requests doesn't download the whole body immediately 
            # if it happens to be an infinite stream, though on error it shouldn't.
            response = requests.post(
                config['url'],
                json=config['payload'],
                headers=headers,
                stream=True
            )
            
            status = response.status_code
            print(f"✅ HTTP Status Code: {status}")
            
            # The bug we fixed would return HTTP 200 on an error stream
            if status == 200:
                print("⚠️ WARNING: Got HTTP 200. Let's check if the body contains an error...")
            elif status in [500, 503]:
                print(f"🎉 SUCCESS: Correctly received error status code ({status})")
            else:
                print(f"ℹ️ Received status code {status}")
            
            # Print the content
            try:
                # Read the response (it should just be a JSON error object, not a stream)
                text = response.text
                if text.strip():
                    print("📄 Response Body:")
                    try:
                        parsed_json = json.loads(text)
                        print(json.dumps(parsed_json, indent=2, ensure_ascii=False))
                    except json.JSONDecodeError:
                        print(text)
                else:
                    print("📄 Empty Response Body")
            except Exception as e:
                print(f"❌ Error reading response body: {e}")
                
        except requests.exceptions.ConnectionError:
            print("❌ Connection Error: Is the API server running locally on port 7861?")
        except Exception as e:
            print(f"❌ Unexpected Error: {e}")
            
        print("-" * 40)
        time.sleep(1) # Small delay between requests

if __name__ == "__main__":
    test_streaming_error_handling()
