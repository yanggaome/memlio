import { join } from 'node:path';
import { MODEL } from './config.js';

export interface Embedder {
  readonly name: string;
  embed(texts: string[]): Promise<number[][]>;
  dispose(): Promise<void>;
}

export class LocalEmbedder implements Embedder {
  readonly name = `${MODEL}:q8:mean:normalized:v1`;
  private extractor: any;
  private loading?: Promise<void>;
  constructor(private home: string) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    if (!this.extractor && !this.loading) {
      this.loading = this.load().finally(() => {
        this.loading = undefined;
      });
    }
    await this.loading;
    const vectors: number[][] = [];
    for (let offset = 0; offset < texts.length; offset += 16) {
      const output = await this.extractor(texts.slice(offset, offset + 16), { pooling: 'mean', normalize: true });
      vectors.push(...output.tolist());
    }
    return vectors;
  }

  private async load(): Promise<void> {
    const offline = process.env.MEMLIO_OFFLINE === '1';
    try {
      const { pipeline, env } = await import('@huggingface/transformers');
      env.cacheDir = process.env.MEMLIO_MODEL_CACHE ?? join(this.home, 'models');
      env.localModelPath = env.cacheDir;
      env.allowLocalModels = true;
      env.allowRemoteModels = !offline;
      env.backends.onnx.logLevel = 'error';
      this.extractor = await pipeline('feature-extraction', MODEL, { dtype: 'q8', device: 'cpu', local_files_only: offline });
    } catch (error) {
      throw new Error(describeModelError(error, offline));
    }
  }

  async dispose() {
    try {
      await this.loading;
    } catch {
      /* A failed load leaves nothing to dispose. */
    }
    if (this.extractor) {
      await this.extractor.dispose();
      this.extractor = undefined;
    }
  }
}

/** Translate Transformers.js/ONNX failures into one sentence a user can act on. */
function describeModelError(error: unknown, offline: boolean): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/not found locally|allowRemoteModels|local_files_only/i.test(message)) {
    return offline
      ? 'The local embedding model is not downloaded and MEMLIO_OFFLINE=1 prevents downloading it.'
      : 'The local embedding model is not downloaded yet and could not be fetched.';
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network/i.test(message)) {
    return `Could not download the embedding model from Hugging Face (${message}). It will be fetched automatically once the network is available.`;
  }
  if (/dlopen|onnxruntime/i.test(message)) {
    return `The ONNX runtime failed to load (${message}). Run memlio with a separately installed Node, for example from nvm.`;
  }
  return `Embedding model error: ${message}`;
}

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0;
  let an = 0;
  let bn = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    an += a[i] ** 2;
    bn += b[i] ** 2;
  }
  return an && bn ? dot / Math.sqrt(an * bn) : 0;
}
