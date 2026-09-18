import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, existsSync, realpathSync, statSync, rmSync, copyFileSync, chmodSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, basename, extname, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { loadConfig, atomicWrite, errorText } from './config.js';
import { fetchPage, extractPage } from './capture.js';
import { type Embedder, LocalEmbedder, cosine } from './embedding.js';
import { type ClipboardReader, readClipboardImage, pngDimensions } from './clipboard.js';
import { z } from 'zod';

export type Kind = 'note' | 'url' | 'file';
export interface Item {
  id: string;
  kind: Kind;
  title: string;
  original: string;
  note: string;
  description: string;
  source: string;
  created: string;
  updated: string;
  text: string;
  asset: string | null;
  capture: 'pending' | 'ready' | 'failed';
  captureError: string | null;
  indexing: 'pending' | 'ready' | 'failed';
  indexError: string | null;
  hash: string;
  finalUrl: string | null;
  capturedAt: string | null;
}
export interface StoreInput {
  input: string;
  kind?: Kind;
  title?: string;
  note?: string;
  description?: string;
  source?: string;
  /** Save only; skip page capture and embedding until the next repair. Used by the evaluation script. */
  defer?: boolean;
  /** Save the image on the system clipboard as a PNG file. `input` must then be empty. */
  clipboard?: boolean;
  /** A page snapshot taken in the browser, so the URL is not fetched. `text` is the plain fallback when no article is found. */
  page?: { html: string; text?: string; title?: string };
  /** A PNG screenshot kept as the item's asset. Only URL items take one. */
  screenshot?: Buffer;
}
export interface ImageInfo {
  width: number | null;
  height: number | null;
  bytes: number;
  mediaType: 'image/png';
}
export interface SearchOptions {
  limit?: number;
  kind?: Kind;
  after?: string;
  before?: string;
  minSimilarity?: number;
}
export interface SearchResult {
  id: string;
  score: number;
  excerpt: string;
  keyword: boolean;
  similarity: number | null;
  title: string;
  kind: Kind;
  created: string;
  source: string;
  url: string | null;
  assetPath: string | null;
  reason: string;
}

const STOP = new Set(
  'a an and are as at be been but by can did do for from had has have how i in is it its me my of on or our that the their them there these this those to was were what when where which who with would you your find saved remember about thing something'.split(
    ' ',
  ),
);
const CHUNK_SIZE = 900;
const CHUNK_STEP = 750;
// The title/note/description prefix is repeated in every chunk. The model reads about 512 tokens,
// so the prefix is capped to leave room for the body text.
const CONTEXT_LIMIT = 300;
const FILE_LIMIT = 20 * 1024 * 1024;
const TEXT_EXTENSIONS = ['.txt', '.md', '.csv', '.json'];
const LIMIT_MESSAGE = 'Files and images are limited to 20 MB.';

/** Bytes to keep as an asset, with where they came from and a default title. */
interface AssetSource {
  bytes: Buffer;
  extension: string;
  original: string;
  title: string;
}

export function terms(text: string): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  return [...new Set(words.filter((t) => t.length > 1 && !STOP.has(t)))].slice(0, 40);
}

export function chunkText(text: string): string[] {
  const result: string[] = [];
  for (let i = 0; i < text.length; i += CHUNK_STEP) {
    result.push(text.slice(i, i + CHUNK_SIZE));
    if (i + CHUNK_SIZE >= text.length) break;
  }
  return result.length ? result : [''];
}

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
/** Local "YYYY-MM-DD HH:MM" without depending on ICU locale data. */
const localStamp = (d: Date) =>
  [d.getFullYear(), d.getMonth() + 1, d.getDate()].map((n, i) => String(n).padStart(i ? 2 : 4, '0')).join('-') +
  ' ' +
  [d.getHours(), d.getMinutes()].map((n) => String(n).padStart(2, '0')).join(':');
type PathRules = Pick<typeof import('node:path'), 'relative' | 'isAbsolute' | 'sep'>;

/** True when path is root or lies inside it. Rules default to this platform; tests pass path.win32 or path.posix. */
export function within(path: string, root: string, rules: PathRules = { relative, isAbsolute, sep }): boolean {
  const rel = rules.relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${rules.sep}`) && !rules.isAbsolute(rel));
}

function parseItem(record: string): Item {
  const item = JSON.parse(record) as Omit<Item, 'indexing'> & { indexing: Item['indexing'] | 'disabled' };
  // Collections created before semantic search became mandatory may hold 'disabled'.
  if (item.indexing === 'disabled') item.indexing = 'pending';
  return item as Item;
}

export class Memory {
  readonly db: DatabaseSync;
  readonly config;
  readonly embedder: Embedder;

  constructor(
    readonly home: string,
    embedder?: Embedder,
    private readonly clipboard: ClipboardReader = readClipboardImage,
  ) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(join(home, 'assets'), { recursive: true, mode: 0o700 });
    this.config = loadConfig(home);
    this.embedder = embedder ?? new LocalEmbedder(home);
    this.db = new DatabaseSync(join(home, 'memory.sqlite'));
    this.db.exec(`PRAGMA busy_timeout=15000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chunks (id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        text TEXT NOT NULL, vector TEXT, model TEXT);
      CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(id UNINDEXED, item_id UNINDEXED, text, tokenize='porter unicode61');
      CREATE TRIGGER IF NOT EXISTS chunks_deleted AFTER DELETE ON chunks BEGIN DELETE FROM search WHERE id=old.id; END;`);
    chmodSync(join(home, 'memory.sqlite'), 0o600);
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  get(id: string): Item {
    const row = this.db.prepare('SELECT record FROM items WHERE id=?').get(id) as { record: string } | undefined;
    if (!row) throw new Error(`Memory ${id} was not found.`);
    return parseItem(row.record);
  }

  list(): Item[] {
    const rows = this.db.prepare('SELECT record FROM items ORDER BY rowid DESC').all() as { record: string }[];
    return rows.map((r) => parseItem(r.record));
  }

  private update(item: Item) {
    item.updated = new Date().toISOString();
    this.db.prepare('UPDATE items SET record=? WHERE id=?').run(JSON.stringify(item), item.id);
  }

  /** Rebuild an item's chunks and keyword entries, keeping vectors whose chunk text did not change. */
  private buildChunks(item: Item) {
    const previous = new Map(
      (
        this.db.prepare('SELECT id,text,vector,model FROM chunks WHERE item_id=?').all(item.id) as {
          id: string;
          text: string;
          vector: string | null;
          model: string | null;
        }[]
      ).map((c) => [c.id, c]),
    );
    this.db.prepare('DELETE FROM chunks WHERE item_id=?').run(item.id);
    const context = [item.title, item.note, item.description, item.kind === 'url' ? item.original : '']
      .filter(Boolean)
      .join('\n')
      .slice(0, CONTEXT_LIMIT);
    const parts = chunkText(item.text);
    let pending = 0;
    for (const [n, part] of parts.entries()) {
      const id = `${item.id}:${n}`;
      const text = `${context}\n${part}`;
      const old = previous.get(id);
      const keep = old && old.text === text && old.vector && old.model === this.embedder.name;
      if (!keep) pending++;
      this.db
        .prepare('INSERT INTO chunks(id,item_id,text,vector,model) VALUES(?,?,?,?,?)')
        .run(id, item.id, text, keep ? old.vector : null, keep ? old.model : null);
      this.db.prepare('INSERT INTO search(id,item_id,text) VALUES(?,?,?)').run(id, item.id, text);
    }
    item.indexing = pending ? 'pending' : 'ready';
    item.indexError = null;
  }

  /** Reads a local file the caller may access. */
  private readFile(input: string, fileAccess: { explicit?: boolean; roots?: string[] }): AssetSource {
    const path = resolve(input);
    if (!existsSync(path)) throw new Error(`File not found: ${path}`);
    const original = realpathSync(path);
    const roots = [...this.config.allowedPaths, ...(fileAccess.roots ?? [])].filter(existsSync).map((p) => realpathSync(p));
    if (!fileAccess.explicit && !roots.some((root) => within(original, root))) {
      throw new Error(
        `${original} is outside the folders memlio may read. Allow it with: memlio setup <client> --allow-path <folder>`,
      );
    }
    const stat = statSync(original);
    if (!stat.isFile()) throw new Error('Capture requires a regular file.');
    if (stat.size > FILE_LIMIT) throw new Error(LIMIT_MESSAGE);
    const extension = extname(original)
      .toLowerCase()
      .replace(/[^.a-z0-9]/g, '')
      .slice(0, 12);
    return { bytes: readFileSync(original), extension, original, title: basename(original) };
  }

  /** Reads the image on the system clipboard. */
  private async readClipboard(now: Date): Promise<AssetSource> {
    const bytes = await this.clipboard();
    return { bytes, extension: '.png', original: `clipboard:${now.toISOString()}`, title: `Pasted image ${localStamp(now)}` };
  }

  async store(
    input: StoreInput,
    fileAccess: { explicit?: boolean; roots?: string[] } = {},
  ): Promise<{ item: Item; duplicate: boolean; enriched: boolean; image?: ImageInfo }> {
    if (input.clipboard) {
      if (input.input.trim()) throw new Error('Use input or clipboard, not both.');
      if (input.kind && input.kind !== 'file') throw new Error('Clipboard images are always saved as files.');
    } else if (!input.input.trim()) throw new Error('Provide non-empty text, a URL, or a file path.');
    if (input.input.length > 1_000_000) throw new Error('Input exceeds 1 million characters.');
    if ((input.title?.length ?? 0) > 500 || (input.note?.length ?? 0) > 20_000 || (input.description?.length ?? 0) > 20_000) {
      throw new Error('Title/context exceeds its size limit.');
    }
    if ((input.source?.length ?? 0) > 1000) throw new Error('Source exceeds 1000 characters.');
    const looksLikeFile = isAbsolute(input.input) || input.input.startsWith('./') || input.input.startsWith('../');
    const kind: Kind = input.clipboard
      ? 'file'
      : (input.kind ?? (/^https?:\/\//i.test(input.input) ? 'url' : looksLikeFile ? 'file' : 'note'));
    if ((input.page || input.screenshot) && kind !== 'url') {
      throw new Error('A page snapshot or screenshot can only accompany a URL.');
    }
    const now = new Date();
    let text = kind === 'note' ? input.input : '';
    let original = input.input;
    let defaultTitle = original.split('\n')[0].slice(0, 100);
    let pageTitle: string | undefined;
    let captureError: string | null = null;
    let pageUsed = false;
    const fingerprintOf = (digest: string | undefined) =>
      hash(JSON.stringify([kind, digest ?? original, input.note ?? '', input.description ?? '', input.title ?? '']));
    let bytes: Buffer | undefined;
    let digest: string | undefined;
    let asset: string | null = null;
    let image: ImageInfo | undefined;
    if (kind === 'url') {
      if (original.length > 8192) throw new Error('URL exceeds 8192 characters.');
      const url = new URL(original);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw new Error('Use an HTTP(S) URL without credentials.');
      }
      defaultTitle = url.hostname;
      // A repeat save of the same URL and context enriches the earlier item, so only extract what it still lacks.
      const prior = this.byHash(fingerprintOf(undefined));
      if (input.page && prior?.capture !== 'ready') {
        if (input.page.html.length > 5_000_000 || (input.page.text?.length ?? 0) > 1_000_000) {
          throw new Error('Page snapshot exceeds its size limit.');
        }
        pageUsed = true;
        try {
          if (!input.page.html.trim()) throw new Error('The browser sent no page content.');
          ({ markdown: text, title: pageTitle } = extractPage(input.page.html, original));
        } catch (e) {
          // No article on the page: keep its visible text if the browser sent any, otherwise record the failure.
          if (input.page.text?.trim()) text = input.page.text.trim();
          else captureError = errorText(e);
          pageTitle = input.page.title;
        }
      }
      if (input.screenshot && !prior?.asset) {
        if (input.screenshot.length > FILE_LIMIT) throw new Error(LIMIT_MESSAGE);
        const size = pngDimensions(input.screenshot);
        if (!size) throw new Error('Screenshots must be PNG images.');
        bytes = input.screenshot;
        asset = `${hash(bytes)}.png`;
        image = { ...size, bytes: bytes.length, mediaType: 'image/png' };
      }
    }
    if (kind === 'file') {
      // Every byte source ends up here: one limit, one hash, one asset name, one place that inspects the bytes.
      const source = input.clipboard ? await this.readClipboard(now) : this.readFile(input.input, fileAccess);
      if (source.bytes.length > FILE_LIMIT) throw new Error(LIMIT_MESSAGE);
      ({ bytes, original } = source);
      defaultTitle = source.title;
      digest = hash(bytes);
      asset = `${digest}${source.extension}`;
      if (TEXT_EXTENSIONS.includes(source.extension)) text = bytes.toString('utf8').slice(0, 1_000_000);
      if (source.extension === '.png') {
        const size = pngDimensions(bytes);
        image = { width: size?.width ?? null, height: size?.height ?? null, bytes: bytes.length, mediaType: 'image/png' };
      }
    }
    const fingerprint = fingerprintOf(digest);
    // A page arrives captured only from the browser; other URLs are fetched afterwards by process().
    const captured = kind !== 'url' || (pageUsed && !captureError);
    const item: Item = {
      id: 'm_' + randomUUID().replaceAll('-', ''),
      kind,
      title: input.title || pageTitle?.trim().slice(0, 500) || defaultTitle,
      original,
      note: input.note ?? '',
      description: input.description ?? '',
      source: input.source ?? 'cli',
      created: now.toISOString(),
      updated: now.toISOString(),
      text,
      asset,
      capture: captured ? 'ready' : pageUsed ? 'failed' : 'pending',
      captureError,
      indexing: 'pending',
      indexError: null,
      hash: fingerprint,
      finalUrl: pageUsed && captured ? original : null,
      capturedAt: captured ? now.toISOString() : null,
    };
    const writeAsset = () => {
      if (asset && bytes && !existsSync(join(this.home, 'assets', asset))) atomicWrite(join(this.home, 'assets', asset), bytes);
    };
    const saved = this.transaction(() => {
      const existing = this.byHash(fingerprint);
      if (existing) {
        // The same thing saved again: keep the one item, but take a page snapshot or screenshot it did not have.
        let enriched = false;
        if (pageUsed && captured && existing.capture !== 'ready') {
          existing.text = text;
          if (pageTitle?.trim() && existing.title === new URL(existing.original).hostname) {
            existing.title = pageTitle.trim().slice(0, 500);
          }
          existing.capture = 'ready';
          existing.captureError = null;
          existing.finalUrl = original;
          existing.capturedAt = now.toISOString();
          enriched = true;
        }
        if (asset && bytes && !existing.asset) {
          writeAsset();
          existing.asset = asset;
          enriched = true;
        }
        if (enriched) {
          this.buildChunks(existing);
          this.update(existing);
        }
        return { item: existing, duplicate: true, enriched };
      }
      writeAsset();
      this.db.prepare('INSERT INTO items VALUES(?,?,?)').run(item.id, item.hash, JSON.stringify(item));
      this.buildChunks(item);
      this.update(item);
      return { item, duplicate: false, enriched: false };
    });
    if ((!saved.duplicate || saved.enriched) && !input.defer) {
      // A browser snapshot is final: embed it, but never re-fetch the page from here.
      if (pageUsed) await this.embedPending(saved.item.id).catch(() => {});
      else await this.process(saved.item.id, Boolean(input.title));
      saved.item = this.get(saved.item.id);
    }
    // Image details describe the stored screenshot only, never one the existing item already had.
    return image && saved.item.asset === asset ? { ...saved, image } : saved;
  }

  private byHash(fingerprint: string): Item | undefined {
    const row = this.db.prepare('SELECT record FROM items WHERE hash=?').get(fingerprint) as { record: string } | undefined;
    return row ? parseItem(row.record) : undefined;
  }

  /** Finish one item: capture its page if needed, then embed its chunks. Failures are recorded on the item. */
  async process(id: string, preserveTitle = false) {
    await this.captureItem(id, preserveTitle);
    await this.embedPending(id).catch(() => {
      /* Recorded on the item as indexing: failed. */
    });
  }

  private async captureItem(id: string, preserveTitle: boolean) {
    let item = this.get(id);
    if (item.kind !== 'url' || item.capture === 'ready') return;
    try {
      const page = await fetchPage(item.original);
      const extracted = page.contentType.startsWith('text/plain')
        ? { title: item.title, markdown: page.body }
        : extractPage(page.body, page.url);
      this.transaction(() => {
        item = this.get(id);
        item.text = extracted.markdown;
        if (!preserveTitle && item.title === new URL(item.original).hostname) item.title = extracted.title.slice(0, 500);
        item.capture = 'ready';
        item.captureError = null;
        item.finalUrl = page.url;
        item.capturedAt = new Date().toISOString();
        this.buildChunks(item);
        this.update(item);
      });
    } catch (e) {
      this.transaction(() => {
        item = this.get(id);
        item.capture = 'failed';
        item.captureError = errorText(e);
        this.update(item);
      });
    }
  }

  /** Embed every chunk that lacks a current vector, for one item or the whole collection. Throws if the model is unavailable. */
  private async embedPending(itemId?: string) {
    const rows = this.db
      .prepare(`SELECT id,item_id,text FROM chunks WHERE (vector IS NULL OR model!=?)${itemId ? ' AND item_id=?' : ''}`)
      .all(...(itemId ? [this.embedder.name, itemId] : [this.embedder.name])) as { id: string; item_id: string; text: string }[];
    if (!rows.length) return;
    const affected = [...new Set(rows.map((r) => r.item_id))];
    try {
      const vectors = await this.embedder.embed(rows.map((r) => r.text));
      if (vectors.length !== rows.length || vectors.some((v) => !v.length || v.some((n) => !Number.isFinite(n)))) {
        throw new Error('Embedding provider returned invalid vectors.');
      }
      this.transaction(() => {
        for (let i = 0; i < rows.length; i++) {
          // Do not attach an old vector if another process changed this chunk meanwhile.
          this.db
            .prepare('UPDATE chunks SET vector=?,model=? WHERE id=? AND text=?')
            .run(JSON.stringify(vectors[i]), this.embedder.name, rows[i].id, rows[i].text);
        }
        for (const id of affected) this.refreshIndexing(id, null);
      });
    } catch (e) {
      this.transaction(() => {
        for (const id of affected) this.refreshIndexing(id, errorText(e));
      });
      throw e;
    }
  }

  private refreshIndexing(id: string, error: string | null) {
    if (!this.db.prepare('SELECT id FROM items WHERE id=?').get(id)) return;
    const item = this.get(id);
    const pending = this.db
      .prepare('SELECT count(*) AS n FROM chunks WHERE item_id=? AND (vector IS NULL OR model!=?)')
      .get(id, this.embedder.name) as { n: number };
    item.indexing = error ? 'failed' : pending.n ? 'pending' : 'ready';
    item.indexError = error;
    this.update(item);
  }

  async search(query: string, options: SearchOptions = {}) {
    if (!query.trim() || query.length > 10_000) throw new Error('Search query must contain 1–10000 characters.');
    const limit = options.limit ?? 5;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('Limit must be an integer from 1 to 50.');
    for (const date of [options.after, options.before]) {
      if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Dates must use YYYY-MM-DD.');
    }
    const eligible = new Map(
      this.list()
        .filter(
          (i) =>
            (!options.kind || i.kind === options.kind) &&
            (!options.after || i.created.slice(0, 10) >= options.after) &&
            (!options.before || i.created.slice(0, 10) <= options.before),
        )
        .map((i) => [i.id, i]),
    );
    type Candidate = { id: string; score: number; excerpt: string; keyword: boolean; similarity: number | null };
    const candidates = new Map<string, Candidate>();
    const add = (id: string, score: number, excerpt: string, keyword: boolean, similarity: number | null) => {
      if (!eligible.has(id)) return;
      const current = candidates.get(id);
      if (current) {
        current.score += score;
        current.keyword ||= keyword;
        if (similarity !== null) current.similarity = Math.max(current.similarity ?? -1, similarity);
      } else candidates.set(id, { id, score, excerpt: excerpt.slice(0, 600), keyword, similarity });
    };

    // Keyword branch: FTS5 with BM25, best chunk per item.
    const tokens = terms(query);
    if (tokens.length) {
      const rows = this.db
        .prepare('SELECT item_id,text,bm25(search) AS rank FROM search WHERE search MATCH ? ORDER BY rank')
        .all(tokens.map((t) => `"${t}"`).join(' OR ')) as { item_id: string; text: string; rank: number }[];
      const seen = new Set<string>();
      let rank = 0;
      for (const row of rows) {
        if (!eligible.has(row.item_id) || seen.has(row.item_id)) continue;
        seen.add(row.item_id);
        add(row.item_id, 1 / (60 + ++rank), row.text, true, null);
      }
    }

    // Semantic branch: embed anything still pending, then the query. Falls back to keyword-only if the model is unavailable.
    const warnings: string[] = [];
    let mode: 'hybrid' | 'keyword' = 'keyword';
    const hasChunks = (this.db.prepare('SELECT count(*) AS n FROM chunks').get() as { n: number }).n > 0;
    if (hasChunks) {
      try {
        await this.embedPending();
        const [vector] = await this.embedder.embed([query]);
        mode = 'hybrid';
        const indexed = this.db
          .prepare('SELECT item_id,text,vector FROM chunks WHERE vector IS NOT NULL AND model=?')
          .all(this.embedder.name) as { item_id: string; text: string; vector: string }[];
        const rows = indexed
          .filter((r) => eligible.has(r.item_id))
          .map((r) => ({ ...r, similarity: cosine(vector, JSON.parse(r.vector)) }))
          .filter((r) => r.similarity >= (options.minSimilarity ?? 0.25))
          .sort((a, b) => b.similarity - a.similarity);
        const seen = new Set<string>();
        let rank = 0;
        for (const row of rows) {
          if (seen.has(row.item_id)) continue;
          seen.add(row.item_id);
          add(row.item_id, 1 / (60 + ++rank), row.text, false, row.similarity);
        }
      } catch (e) {
        warnings.push(`Semantic search unavailable: ${errorText(e)} Showing keyword matches only.`);
      }
    }

    const results: SearchResult[] = [...candidates.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((r) => {
        const item = eligible.get(r.id)!;
        return {
          ...r,
          title: item.title,
          kind: item.kind,
          created: item.created,
          source: item.source,
          url: item.kind === 'url' ? item.original : null,
          assetPath: item.asset ? join(this.home, 'assets', item.asset) : null,
          reason: [
            r.keyword ? 'Keyword match in saved content or context' : '',
            r.similarity !== null ? `Semantic similarity ${r.similarity.toFixed(3)}` : '',
          ]
            .filter(Boolean)
            .join('; '),
        };
      });
    return { query, mode, warnings, results };
  }

  status() {
    const items = this.list();
    const failures = items
      .filter((i) => i.captureError || i.indexError)
      .map((i) => ({ id: i.id, title: i.title, captureError: i.captureError, indexError: i.indexError }));
    const capturePending = items.filter((i) => i.capture === 'pending').length;
    const indexPending = items.filter((i) => i.indexing === 'pending').length;
    return {
      home: this.home,
      count: items.length,
      model: this.embedder.name,
      capturePending,
      captureFailed: items.filter((i) => i.capture === 'failed').length,
      indexPending,
      indexFailed: items.filter((i) => i.indexing === 'failed').length,
      failures,
      next: failures.length || capturePending || indexPending ? 'Run memlio repair to retry unfinished work.' : null,
    };
  }

  delete(id: string) {
    const item = this.get(id);
    this.transaction(() => {
      this.db.prepare('DELETE FROM items WHERE id=?').run(id);
    });
    // Metadata deletion is committed first; a cleanup failure must not resurrect an item with missing bytes.
    let cleanupError: string | null = null;
    try {
      if (item.asset && !this.list().some((i) => i.asset === item.asset))
        rmSync(join(this.home, 'assets', item.asset), { force: true });
    } catch (e) {
      cleanupError = errorText(e);
    }
    return { deleted: id, cleanupError };
  }

  /** Rebuild search data from the stored records, retry failed page captures, and embed anything missing. */
  async repair() {
    this.transaction(() => {
      this.db.exec('DELETE FROM search');
      for (const item of this.list()) {
        this.buildChunks(item);
        this.update(item);
      }
    });
    for (const item of this.list()) if (item.capture !== 'ready') await this.captureItem(item.id, false);
    await this.embedPending().catch(() => {
      /* Recorded on the items as indexing: failed. */
    });
    return this.status();
  }

  export(destination: string) {
    const target = resolve(destination);
    if (within(target, this.home) || within(this.home, target))
      throw new Error('Export destination must be separate from the collection.');
    if (existsSync(target)) throw new Error('Export destination already exists; choose a new directory.');
    return this.transaction(() => {
      mkdirSync(join(target, 'assets'), { recursive: true, mode: 0o700 });
      const items = this.list();
      atomicWrite(join(target, 'records.json'), JSON.stringify({ version: 1, items }, null, 2));
      for (const asset of new Set(items.map((i) => i.asset).filter((v): v is string => Boolean(v)))) {
        copyFileSync(join(this.home, 'assets', asset), join(target, 'assets', asset));
      }
      return { destination: target, count: items.length };
    });
  }

  async import(directory: string) {
    const root = realpathSync(directory);
    const recordSchema = z.object({
      id: z.string().regex(/^m_[a-f0-9]{32}$/),
      kind: z.enum(['note', 'url', 'file']),
      title: z.string().max(500),
      original: z.string().max(1_000_000),
      note: z.string().max(20_000),
      description: z.string().max(20_000),
      source: z.string().max(1000),
      created: z.string().datetime(),
      updated: z.string().datetime(),
      text: z.string().max(5_000_000),
      asset: z
        .string()
        .regex(/^[a-f0-9]{64}(\.[a-z0-9]{1,11})?$/)
        .nullable(),
      capture: z.enum(['pending', 'ready', 'failed']),
      captureError: z.string().nullable(),
      indexing: z.enum(['pending', 'ready', 'disabled', 'failed']),
      indexError: z.string().nullable(),
      hash: z.string().regex(/^[a-f0-9]{64}$/),
      finalUrl: z.string().nullable(),
      capturedAt: z.string().datetime().nullable(),
    });
    const manifest = join(root, 'records.json');
    if (!existsSync(manifest))
      throw new Error(`No records.json in ${root}. Point import at a directory created by memlio export.`);
    if (statSync(manifest).size > 100 * 1024 * 1024) throw new Error('Import manifest exceeds 100 MB.');
    const { items } = z
      .object({ version: z.literal(1), items: z.array(recordSchema).max(100_000) })
      .parse(JSON.parse(readFileSync(manifest, 'utf8')));
    const assets = new Map<string, Buffer>();
    for (const item of items) {
      if (!item.asset || assets.has(item.asset)) continue;
      const path = realpathSync(join(root, 'assets', item.asset));
      if (!within(path, root) || statSync(path).size > FILE_LIMIT) throw new Error('Invalid import asset path or size.');
      const bytes = readFileSync(path);
      if (!item.asset.startsWith(hash(bytes))) throw new Error('Import asset content hash mismatch.');
      assets.set(item.asset, bytes);
    }
    const result = this.transaction(() => {
      let imported = 0;
      let duplicates = 0;
      for (const record of items) {
        if (this.db.prepare('SELECT id FROM items WHERE hash=?').get(record.hash)) {
          duplicates++;
          continue;
        }
        if (this.db.prepare('SELECT id FROM items WHERE id=?').get(record.id))
          throw new Error(`Import ID collision: ${record.id}`);
        if (record.asset && !existsSync(join(this.home, 'assets', record.asset))) {
          atomicWrite(join(this.home, 'assets', record.asset), assets.get(record.asset)!);
        }
        const item: Item = { ...record, indexing: 'pending', indexError: null };
        this.db.prepare('INSERT INTO items VALUES(?,?,?)').run(item.id, item.hash, JSON.stringify(item));
        this.buildChunks(item);
        this.update(item);
        imported++;
      }
      return { imported, duplicates };
    });
    await this.embedPending().catch(() => {
      /* Recorded on the items; status() points at repair. */
    });
    return { ...result, ...this.status() };
  }

  async close() {
    this.db.close();
    await this.embedder.dispose();
  }
}

/** The short save receipt shared by the CLI and the MCP tool. */
export function summarize(saved: { item: Item; duplicate: boolean; enriched?: boolean; image?: ImageInfo }) {
  const { item, duplicate, enriched, image } = saved;
  return {
    id: item.id,
    title: item.title,
    duplicate,
    ...(enriched ? { enriched } : {}),
    ...(image ? { image } : {}),
    capture: item.capture,
    captureError: item.captureError,
    indexing: item.indexing,
    indexError: item.indexError,
  };
}
export type Summary = ReturnType<typeof summarize>;
