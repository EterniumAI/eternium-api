# eternium-sdk

Official JavaScript/TypeScript SDK for the [Eternium API](https://api.eternium.ai) -- AI image, video, chat, embeddings, and audio generation.

## Install

```bash
npm install eternium-sdk
```

## Quick Start

```javascript
import { Eternium } from 'eternium-sdk'

const client = new Eternium('etrn_your_key')

// Generate an image
const image = await client.image('A futuristic city at sunset')
console.log(image.url)

// Generate a video
const video = await client.video('Ocean waves on rocks', { model: 'veo-3', duration: 5 })
console.log(video.url)

// Run a multi-step pipeline
const pack = await client.runPipeline('social-media-pack', 'Product on white background')
console.log(pack.results)
```

## Features

- 24 AI models (image, video, chat, embeddings, audio)
- Automatic polling until generation completes
- Built-in prompt caching (saves credits on repeated calls)
- Progress callbacks
- TypeScript types included
- ESM and CommonJS support

## API

### `new Eternium(apiKey, options?)`

| Option | Default | Description |
|--------|---------|-------------|
| `baseUrl` | `https://api.eternium.ai` | API base URL |
| `pollInterval` | `3000` | Polling interval in ms |
| `timeout` | `300000` | Max wait time in ms |

### Methods

| Method | Description |
|--------|-------------|
| `client.image(prompt, opts?)` | Generate an image, wait for result |
| `client.video(prompt, opts?)` | Generate a video, wait for result |
| `client.runPipeline(name, prompt, opts?)` | Run a multi-step pipeline |
| `client.listModels()` | List all available models |
| `client.listPipelines()` | List available pipelines |
| `client.listTiers()` | Get pricing tiers |
| `client.getUsage()` | Check credit usage and budget |
| `client.getTaskStatus(taskId)` | Poll task status |
| `client.getDownloadUrl(taskId)` | Get download URL (20min expiry) |

### Options

```javascript
const result = await client.image('prompt', {
  model: 'nano-banana-2',     // Model to use
  aspect_ratio: '16:9',       // Aspect ratio
  cache: true,                 // Enable prompt caching (default: true)
  wait: true,                  // Wait for completion (default: true)
  onProgress: ({ status }) => console.log(status),
})
```

## OpenAI-Compatible

The Eternium API also supports OpenAI-compatible endpoints. Use the standard OpenAI SDK:

```javascript
import OpenAI from 'openai'

const openai = new OpenAI({
  apiKey: 'etrn_your_key',
  baseURL: 'https://api.eternium.ai/v1',
})

const chat = await openai.chat.completions.create({
  model: 'gpt-5.1',
  messages: [{ role: 'user', content: 'Hello!' }],
})
```

## License

MIT - Eternium LLC
