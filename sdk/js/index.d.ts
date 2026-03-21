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

export interface ImageOptions {
  model?: 'nano-banana-pro' | 'flux-kontext' | 'gpt4o-image';
  aspect_ratio?: '1:1' | '16:9' | '9:16' | '4:3';
  resolution?: '1K' | '4K';
  output_format?: 'png' | 'jpg' | 'webp';
  image_urls?: string[];
  callback_url?: string;
  wait?: boolean;
}

export interface VideoOptions {
  model?: 'kling-3.0' | 'kling-2.6' | 'wan-2.6';
  duration?: 3 | 5 | 10 | 15;
  aspect_ratio?: '16:9' | '9:16' | '1:1';
  mode?: 'std' | 'pro';
  sound?: boolean;
  image_urls?: string[];
  multi_shots?: boolean;
  multi_prompt?: string[];
  kling_elements?: Array<{ image_urls: string[] }>;
  callback_url?: string;
  wait?: boolean;
}

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
  type: 'image' | 'video';
  name: string;
  description: string;
  cost_per_gen: string;
}

export interface PipelineInfo {
  id: string;
  name: string;
  description: string;
  steps: number;
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
  listModels(): Promise<{ models: ModelInfo[] }>;
  listPipelines(): Promise<{ pipelines: PipelineInfo[] }>;
  listTiers(): Promise<Record<string, unknown>>;
  getUsage(): Promise<UsageData>;
  getTaskStatus(taskId: string): Promise<Record<string, unknown>>;
  getDownloadUrl(taskId: string): Promise<Record<string, unknown>>;
}

export default Eternium;
