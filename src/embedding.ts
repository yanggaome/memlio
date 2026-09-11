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
    if (!this.extractor && !this.loading) this.loading = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      env.cacheDir = process.env.MEMLIO_MODEL_CACHE ?? join(this.home, 'models');
      env.localModelPath = env.cacheDir;
      env.allowLocalModels = true;
      env.allowRemoteModels = process.env.MEMLIO_OFFLINE !== '1';
      env.backends.onnx.logLevel = 'error';
      this.extractor = await pipeline('feature-extraction', MODEL, { dtype: 'q8', device: 'cpu', local_files_only: process.env.MEMLIO_OFFLINE === '1' });
    })().finally(() => { this.loading = undefined; });
    await this.loading;
    const vectors: number[][] = [];
    for (let offset = 0; offset < texts.length; offset += 16) {
      const output = await this.extractor(texts.slice(offset, offset + 16), { pooling: 'mean', normalize: true });
      vectors.push(...output.tolist());
    }
    return vectors;
  }
  async dispose() { await this.loading; if (this.extractor) { await this.extractor.dispose(); this.extractor = undefined; } }
}
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0, an = 0, bn = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; an += a[i] ** 2; bn += b[i] ** 2; }
  return an && bn ? dot / Math.sqrt(an * bn) : 0;
}
