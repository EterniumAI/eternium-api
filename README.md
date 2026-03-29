# Eternium API

AI image and video generation API built on Cloudflare Workers.

## Features

- Multi-model support: Nano Banana Pro, Flux Kontext, GPT-4o Image, Kling 3.0/2.6, Wan 2.6
- Multi-step pipelines: product shots, social media packs, video ads, thumbnail packs
- Prompt caching for agent deduplication
- Per-key usage tracking and budget enforcement
- Tiered pricing with Stripe billing integration
- Self-serve signup, dashboard, and admin panel
- JavaScript and Python SDKs

## Quick Start

```bash
npm install
npm run dev
```

See [DEPLOY.md](DEPLOY.md) for full deployment instructions.

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | No | Health check |
| GET | `/v1/models` | No | List available models |
| GET | `/v1/pipelines` | No | List available pipelines |
| GET | `/v1/tiers` | No | List pricing tiers |
| GET | `/docs` | No | API documentation (JSON) |
| POST | `/v1/generate` | Yes | Generate image or video |
| POST | `/v1/pipelines/run` | Yes | Run a multi-step pipeline |
| GET | `/v1/tasks/:id` | Yes | Check task status |
| GET | `/v1/tasks/:id/download` | Yes | Get download URL |
| GET | `/v1/usage` | Yes | Get usage and budget |
| POST | `/v1/chat/completions` | Yes | OpenAI-compatible chat proxy (streaming supported) |
| POST | `/v1/embeddings` | Yes | OpenAI-compatible embeddings proxy |
| POST | `/v1/audio/transcriptions` | Yes | Whisper audio transcription (multipart) |
| POST | `/auth/signup` | No | Create account, returns JWT |
| POST | `/auth/login` | No | Sign in, returns JWT + API key |
| POST | `/auth/provision-key` | JWT | Generate API key (first time) |
| POST | `/auth/regenerate-key` | JWT | Rotate API key (revokes old, issues new) |
| POST | `/auth/checkout` | JWT | Create Stripe checkout session |
| GET | `/auth/stripe-success` | No | Post-payment redirect handler |

## SDKs

### JavaScript / TypeScript

```js
import { Eternium } from 'eternium-sdk'

const client = new Eternium('etrn_your_key')
const result = await client.image('A futuristic city at sunset')
console.log(result.url)
```

### Python

```python
from eternium import Eternium

client = Eternium("etrn_your_key")
result = client.image("A futuristic city at sunset")
print(result["url"])
```

## License

Proprietary - Eternium LLC
