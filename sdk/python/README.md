# eternium-sdk

Official Python SDK for the [Eternium API](https://api.eternium.ai) -- AI image, video, chat, embeddings, and audio generation.

## Install

```bash
pip install eternium-sdk
```

## Quick Start

```python
from eternium import Eternium

client = Eternium("etrn_your_key")

# Generate an image
image = client.image("A futuristic city at sunset")
print(image["url"])

# Generate a video
video = client.video("Ocean waves on rocks", model="veo-3", duration=5)
print(video["url"])

# Run a multi-step pipeline
pack = client.run_pipeline("social-media-pack", "Product on white background")
print(pack["results"])
```

## Features

- 24 AI models (image, video, chat, embeddings, audio)
- Automatic polling until generation completes
- Built-in prompt caching (saves credits on repeated calls)
- Zero external dependencies (stdlib only)
- Python 3.8+

## API

### `Eternium(api_key, base_url=None, poll_interval=3, timeout=300)`

### Methods

| Method | Description |
|--------|-------------|
| `client.image(prompt, **kwargs)` | Generate an image |
| `client.video(prompt, **kwargs)` | Generate a video |
| `client.run_pipeline(name, prompt, **kwargs)` | Run a multi-step pipeline |
| `client.list_models()` | List available models |
| `client.list_pipelines()` | List pipelines |
| `client.list_tiers()` | Get pricing tiers |
| `client.get_usage()` | Check credit usage |
| `client.get_task_status(task_id)` | Poll task status |
| `client.get_download_url(task_id)` | Get download URL |

### Options

```python
result = client.image(
    "A futuristic city",
    model="nano-banana-2",
    aspect_ratio="16:9",
    cache=True,          # Prompt caching (default: True)
    wait=True,           # Wait for completion (default: True)
)
```

## OpenAI-Compatible

The Eternium API also supports OpenAI-compatible endpoints:

```python
from openai import OpenAI

client = OpenAI(
    api_key="etrn_your_key",
    base_url="https://api.eternium.ai/v1",
)

chat = client.chat.completions.create(
    model="gpt-5.1",
    messages=[{"role": "user", "content": "Hello!"}],
)
```

## License

MIT - Eternium LLC
