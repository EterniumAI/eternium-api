export interface EterniumOptions {
  baseUrl?: string;
  pollInterval?: number;
  timeout?: number;
  cache?: boolean;
  onProgress?: (progress: ProgressEvent) => void;
}

export interface ProgressEvent {
  taskId: string;
  status: string;
  elapsed: number;
}

export interface GenerationResult {
  taskId: string;
  status: string;
  url?: string;
  output?: Record<string, unknown>;
  download?: Record<string, unknown>;
  cached?: boolean;
  cost?: string;
}

// ── Image Models ────────────────────────────────────────────────
export type ImageModel =
  | 'nano-banana-2'      // Google — 12 credits — 2K, text rendering, character consistency
  | 'nano-banana-pro'    // Google — 8 credits — fast, native 4K output
  | 'gpt-5.4-image'      // OpenAI — 14 credits — flagship image generation
  | 'gpt4o-image'        // OpenAI — 14 credits — GPT-4o image generation
  | 'flux-kontext'       // Black Forest Labs — 11 credits — reference image editing
  | 'seedream-5'         // ByteDance — 8 credits — up to 4K, fast
  | 'qwen-image-2'       // Qwen — 8 credits — strong text rendering
  | 'midjourney';        // Midjourney — 11 credits — v6, 4 variants

export interface ImageOptions {
  model?: ImageModel;
  aspect_ratio?: '1:1' | '16:9' | '9:16' | '4:3' | '3:4';
  resolution?: '1K' | '2K' | '4K';
  output_format?: 'png' | 'jpg' | 'webp';
  image_urls?: string[];
  callback_url?: string;
  wait?: boolean;
}

// ── Video Models ────────────────────────────────────────────────
export type VideoModel =
  | 'kling-3.0'          // Kling — 91-286 credits — multi-shot, element refs
  | 'kling-3.0-mc'       // Kling — 91-364 credits — camera path control
  | 'kling-2.6'          // Kling — 73-234 credits — audio support
  | 'veo-3'              // Google — 104-520 credits — native audio
  | 'sora-2'             // OpenAI — 130-520 credits — cinematic quality
  | 'seedance-2'         // ByteDance — 91-286 credits — motion specialization
  | 'hailuo-2.3'         // MiniMax — 73-247 credits — std/pro modes
  | 'wan-2.6';           // Alibaba — 78-260 credits — multi-shot HD, audio

export interface VideoOptions {
  model?: VideoModel;
  duration?: 3 | 5 | 10 | 15;
  aspect_ratio?: '16:9' | '9:16' | '1:1';
  mode?: 'std' | 'pro' | 'fast';
  sound?: boolean;
  image_urls?: string[];
  multi_shots?: boolean;
  multi_prompt?: string[];
  kling_elements?: Array<{ image_urls: string[] }>;
  callback_url?: string;
  wait?: boolean;
}

// ── Chat Models ─────────────────────────────────────────────────
export type ChatModel =
  | 'gpt-5.1'            // OpenAI — $0.63/$5.00 per 1M tokens (in/out)
  | 'gpt-5.1-codex-mini' // OpenAI — $0.25/$2.00 per 1M tokens — budget
  | 'gpt-5.4'            // OpenAI — $1.25/$10.00 per 1M tokens — frontier
  | 'gpt-4o'             // OpenAI — legacy, sunset Feb 2026
  | 'gpt-4o-mini';       // OpenAI — legacy, sunset Feb 2026

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  model?: ChatModel;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
}

export interface ChatResult {
  id: string;
  choices: Array<{
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  _credits?: number;
}

// ── Embedding Models ────────────────────────────────────────────
export type EmbeddingModel =
  | 'text-embedding-3-small'  // $0.02/1M tokens — fast, efficient
  | 'text-embedding-3-large'; // $0.13/1M tokens — max accuracy

export interface EmbeddingOptions {
  model?: EmbeddingModel;
  input: string | string[];
}

export interface EmbeddingResult {
  data: Array<{ embedding: number[]; index: number }>;
  usage: { prompt_tokens: number; total_tokens: number };
  _credits?: number;
}

// ── Audio Models ────────────────────────────────────────────────
export type AudioModel = 'whisper-1';

// ── Pipeline ────────────────────────────────────────────────────
export interface PipelineResult {
  pipeline: string;
  total_cost: string;
  results: Array<GenerationResult & { model: string }>;
}

export interface UsageData {
  tier: string;
  tier_name: string;
  monthly_limit: string;
  spent: string;
  remaining: string;
  generations: number;
  cached_hits: number;
  cache_savings: string;
  recent_tasks: Array<{ model: string; cost: number; cached: boolean; ts: number }>;
}

export interface ModelInfo {
  id: string;
  type: 'image' | 'video' | 'chat' | 'embedding' | 'audio';
  name: string;
  provider: string;
  description: string;
  credits_per_gen?: number | string;
  featured?: boolean;
}

export interface PipelineInfo {
  id: string;
  name: string;
  description: string;
  steps: number;
}

export interface TierInfo {
  name: string;
  credits: number;
  rateLimit: number;
  concurrent: number;
}

export class EterniumError extends Error {
  code: number | string;
  data: Record<string, unknown>;
}

export class Eternium {
  constructor(apiKey: string, options?: EterniumOptions);

  generate: {
    image: (prompt: string, opts?: ImageOptions) => Promise<GenerationResult>;
    video: (prompt: string, opts?: VideoOptions) => Promise<GenerationResult>;
  };

  pipeline: {
    run: (name: string, prompt: string, opts?: { wait?: boolean }) => Promise<PipelineResult>;
    list: () => Promise<{ pipelines: PipelineInfo[] }>;
  };

  image(prompt: string, opts?: ImageOptions): Promise<GenerationResult>;
  video(prompt: string, opts?: VideoOptions): Promise<GenerationResult>;
  runPipeline(name: string, prompt: string, opts?: { wait?: boolean }): Promise<PipelineResult>;
  listModels(): Promise<{ models: ModelInfo[]; credit_value: number }>;
  listPipelines(): Promise<{ pipelines: PipelineInfo[] }>;
  listTiers(): Promise<{ tiers: Record<string, TierInfo>; credit_value: number }>;
  getUsage(): Promise<UsageData>;
  getTaskStatus(taskId: string): Promise<Record<string, unknown>>;
  getDownloadUrl(taskId: string): Promise<{ url: string }>;
}

export default Eternium;
