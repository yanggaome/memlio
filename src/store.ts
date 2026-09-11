import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, existsSync, realpathSync, statSync, rmSync, copyFileSync, chmodSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, basename, extname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { loadConfig, atomicWrite } from './config.js';
import { fetchPage, extractPage } from './capture.js';
import { type Embedder, LocalEmbedder, cosine } from './embedding.js';
import { z } from 'zod';

export type Kind = 'note' | 'url' | 'file';
export interface Item {
  id: string; kind: Kind; title: string; original: string; note: string; description: string;
  source: string; created: string; updated: string; text: string; asset: string | null;
  capture: 'pending' | 'ready' | 'failed'; captureError: string | null;
  indexing: 'pending' | 'ready' | 'disabled' | 'failed'; indexError: string | null;
  hash: string; finalUrl: string | null; capturedAt: string | null;
}
export interface StoreInput { input: string; kind?: Kind; title?: string; note?: string; description?: string; source?: string; defer?: boolean; }
export interface SearchOptions { mode?: 'keyword' | 'semantic' | 'hybrid'; limit?: number; kind?: Kind; after?: string; before?: string; minSimilarity?: number; }
const STOP = new Set('a an and are as at be been but by can did do for from had has have how i in is it its me my of on or our that the their them there these this those to was were what when where which who with would you your find saved remember about thing something'.split(' '));
export function terms(text: string) { return [...new Set((text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter(t => t.length > 1 && !STOP.has(t)))].slice(0, 40); }
export function chunkText(text: string): string[] {
  const result: string[] = [];
  for (let i = 0; i < text.length; i += 750) { result.push(text.slice(i, i + 900)); if (i + 900 >= text.length) break; }
  return result.length ? result : [''];
}
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
export function within(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..' + '/') && rel !== '..' && !isAbsolute(rel));
}

export class Memory {
  readonly db: DatabaseSync;
  readonly config;
  readonly embedder: Embedder;
  constructor(readonly home: string, embedder?: Embedder) {
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
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  get(id: string): Item {
    const row = this.db.prepare('SELECT record FROM items WHERE id=?').get(id) as { record: string } | undefined;
    if (!row) throw new Error(`Memory ${id} was not found.`);
    return JSON.parse(row.record);
  }
  list(): Item[] { return (this.db.prepare('SELECT record FROM items ORDER BY rowid DESC').all() as {record: string}[]).map(r => JSON.parse(r.record)); }
  private update(item: Item) { item.updated = new Date().toISOString(); this.db.prepare('UPDATE items SET record=? WHERE id=?').run(JSON.stringify(item), item.id); }
  private buildChunks(item: Item) {
    this.db.prepare('DELETE FROM chunks WHERE item_id=?').run(item.id);
    const context = [item.title, item.note, item.description, item.kind === 'url' ? item.original : ''].filter(Boolean).join('\n');
    const parts = chunkText(item.text);
    for (const [n, part] of parts.entries()) {
      const id = `${item.id}:${n}`;
      const text = `${context}\n${part}`;
      this.db.prepare('INSERT INTO chunks(id,item_id,text) VALUES(?,?,?)').run(id, item.id, text);
      this.db.prepare('INSERT INTO search(id,item_id,text) VALUES(?,?,?)').run(id, item.id, text);
    }
  }
  async store(input: StoreInput, fileAccess: { explicit?: boolean; roots?: string[] } = {}) {
    if (!input.input.trim()) throw new Error('Provide non-empty text, a URL, or a file path.');
    if (input.input.length > 1_000_000) throw new Error('Input exceeds 1 million characters.');
    if ((input.title?.length??0)>500 || (input.note?.length??0)>20_000 || (input.description?.length??0)>20_000) throw new Error('Title/context exceeds its size limit.');
    if ((input.source?.length??0)>1000) throw new Error('Source exceeds 1000 characters.');
    const kind = input.kind ?? (/^https?:\/\//i.test(input.input) ? 'url' : (isAbsolute(input.input) || input.input.startsWith('./') || input.input.startsWith('../')) ? 'file' : 'note');
    let bytes: Buffer | undefined;
    let asset: string | null = null;
    let text = kind === 'note' ? input.input : '';
    let original = input.input;
    if (kind === 'url') {
      if (original.length > 8192) throw new Error('URL exceeds 8192 characters.');
      const url = new URL(original);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP(S) URL without credentials.');
    }
    if (kind === 'file') {
      original = realpathSync(resolve(input.input));
      const roots = [...this.config.allowedPaths, ...(fileAccess.roots ?? [])].filter(existsSync).map(p => realpathSync(p));
      if (!fileAccess.explicit && !roots.some(root => within(original, root))) throw new Error('File is outside allowed roots. Run memlio init --allow-path <folder> or provide an MCP client filesystem root.');
      const stat = statSync(original);
      if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw new Error('Capture requires a regular file no larger than 20 MB.');
      bytes = readFileSync(original);
      if (bytes.length > 20 * 1024 * 1024) throw new Error('File exceeds 20 MB.');
      if (['.txt', '.md', '.csv', '.json'].includes(extname(original).toLowerCase())) text = bytes.toString('utf8').slice(0, 1_000_000);
      asset = `${hash(bytes)}${extname(original).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 12)}`;
    }
    const now = new Date().toISOString();
    const fingerprint = hash(JSON.stringify([kind, bytes ? hash(bytes) : original, input.note ?? '', input.description ?? '', input.title ?? '']));
    const duplicate = this.db.prepare('SELECT id FROM items WHERE hash=?').get(fingerprint) as {id: string} | undefined;
    if (duplicate) return { item: this.get(duplicate.id), duplicate: true };
    const item: Item = {
      id: 'm_' + randomUUID().replaceAll('-', ''), kind,
      title: input.title || (kind === 'url' ? new URL(original).hostname : kind === 'file' ? basename(original) : original.split('\n')[0].slice(0, 100)),
      original, note: input.note ?? '', description: input.description ?? '', source: input.source ?? 'cli',
      created: now, updated: now, text, asset, capture: kind === 'url' ? 'pending' : 'ready', captureError: null,
      indexing: this.config.semantic ? 'pending' : 'disabled', indexError: null, hash: fingerprint, finalUrl: null, capturedAt: kind === 'url' ? null : now,
    };
    const saved = this.transaction(() => {
      const existing = this.db.prepare('SELECT id FROM items WHERE hash=?').get(fingerprint) as {id: string} | undefined;
      if (existing) return { item: this.get(existing.id), duplicate: true };
      if (asset && bytes && !existsSync(join(this.home, 'assets', asset))) atomicWrite(join(this.home, 'assets', asset), bytes);
      this.db.prepare('INSERT INTO items VALUES(?,?,?)').run(item.id, item.hash, JSON.stringify(item));
      this.buildChunks(item);
      return { item, duplicate: false };
    });
    if (saved.duplicate || input.defer) return saved;
    await this.process(item.id, Boolean(input.title));
    return { item: this.get(item.id), duplicate: false };
  }
  async process(id: string, preserveTitle = false) {
    let item = this.get(id);
    if (item.kind === 'url' && item.capture !== 'ready') {
      try {
        const page = await fetchPage(item.original);
        const extracted = page.contentType.startsWith('text/plain') ? { title: item.title, markdown: page.body } : extractPage(page.body, page.url);
        this.transaction(() => {
          item = this.get(id);
          item.text = extracted.markdown;
          if (!preserveTitle && item.title === new URL(item.original).hostname) item.title = extracted.title.slice(0,500);
          item.capture = 'ready'; item.captureError = null; item.finalUrl = page.url; item.capturedAt = new Date().toISOString();
          item.indexing = this.config.semantic ? 'pending' : 'disabled';
          this.update(item); this.buildChunks(item);
        });
      } catch (e) {
        this.transaction(() => { item = this.get(id); item.capture = 'failed'; item.captureError = errorText(e); this.update(item); });
      }
    }
    if (!this.config.semantic) return;
    const rows = this.db.prepare('SELECT id,text FROM chunks WHERE item_id=? AND (vector IS NULL OR model!=?)').all(id, this.embedder.name) as {id:string;text:string}[];
    if (!rows.length) return;
    try {
      const vectors = await this.embedder.embed(rows.map(r => r.text));
      if (vectors.length !== rows.length || vectors.some(v => !v.length || v.some(n => !Number.isFinite(n)))) throw new Error('Embedding provider returned invalid vectors.');
      this.transaction(() => {
        item = this.get(id);
        for (let i = 0; i < rows.length; i++) {
          // Do not attach an old vector if another process changed this chunk meanwhile.
          this.db.prepare('UPDATE chunks SET vector=?,model=? WHERE id=? AND text=?').run(JSON.stringify(vectors[i]), this.embedder.name, rows[i].id, rows[i].text);
        }
        const pending = this.db.prepare('SELECT count(*) AS n FROM chunks WHERE item_id=? AND (vector IS NULL OR model!=?)').get(id, this.embedder.name) as {n:number};
        item.indexing = pending.n ? 'pending' : 'ready'; item.indexError = null; this.update(item);
      });
    } catch (e) {
      if (!this.db.prepare('SELECT id FROM items WHERE id=?').get(id)) return;
      this.transaction(() => { item = this.get(id); item.indexing = 'failed'; item.indexError = errorText(e); this.update(item); });
    }
  }
  async retry() { for (const item of this.list()) if (item.capture !== 'ready' || (this.config.semantic && item.indexing !== 'ready')) await this.process(item.id); return this.status(); }
  async search(query: string, options: SearchOptions = {}) {
    if (!query.trim() || query.length > 10_000) throw new Error('Search query must contain 1–10000 characters.');
    const limit = options.limit ?? 5;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('Limit must be an integer from 1 to 50.');
    for (const date of [options.after, options.before]) if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Dates must use YYYY-MM-DD.');
    const mode = options.mode ?? (this.config.semantic ? 'hybrid' : 'keyword');
    if (mode !== 'keyword' && !this.config.semantic) throw new Error('Semantic search is disabled. Enable it with memlio init --semantic, then run memlio reindex.');
    const eligible = new Map(this.list().filter(i => (!options.kind || i.kind === options.kind) && (!options.after || i.created.slice(0,10) >= options.after) && (!options.before || i.created.slice(0,10) <= options.before)).map(i => [i.id,i]));
    const candidates = new Map<string, { id: string; score: number; excerpt: string; keyword: boolean; similarity: number | null }>();
    const add = (id:string, score:number, excerpt:string, keyword:boolean, similarity:number|null) => {
      if (!eligible.has(id)) return;
      const current = candidates.get(id);
      if (current) { current.score += score; current.keyword ||= keyword; if (similarity !== null) current.similarity = Math.max(current.similarity ?? -1, similarity); }
      else candidates.set(id, {id, score, excerpt: excerpt.slice(0,600), keyword, similarity});
    };
    if (mode !== 'semantic') {
      const tokens = terms(query);
      if (tokens.length) {
        const rows = this.db.prepare("SELECT item_id,text,bm25(search) AS rank FROM search WHERE search MATCH ? ORDER BY rank").all(tokens.map(t => `\"${t}\"`).join(' OR ')) as {item_id:string;text:string;rank:number}[];
        const seen = new Set<string>(); let rank = 0;
        for (const row of rows) if (eligible.has(row.item_id) && !seen.has(row.item_id)) { seen.add(row.item_id); add(row.item_id, 1/(60 + ++rank), row.text, true, null); }
      }
    }
    const warnings: string[] = [];
    if (mode !== 'keyword') {
      const indexed = this.db.prepare('SELECT item_id,text,vector FROM chunks WHERE vector IS NOT NULL AND model=?').all(this.embedder.name) as {item_id:string;text:string;vector:string}[];
      const pending = this.db.prepare('SELECT count(*) AS n FROM chunks WHERE vector IS NULL OR model!=?').get(this.embedder.name) as {n:number};
      if (pending.n) warnings.push(`${pending.n} chunks lack current semantic embeddings; run memlio retry or memlio reindex.`);
      if (indexed.length) {
        const [vector] = await this.embedder.embed([query]);
        const rows = indexed.filter(r => eligible.has(r.item_id)).map(r => ({...r, similarity: cosine(vector, JSON.parse(r.vector))})).filter(r => r.similarity >= (options.minSimilarity ?? 0.25)).sort((a,b) => b.similarity-a.similarity);
        const seen = new Set<string>(); let rank = 0;
        for (const row of rows) if (!seen.has(row.item_id)) { seen.add(row.item_id); add(row.item_id, 1/(60 + ++rank), row.text, false, row.similarity); }
      }
    }
    return { query, mode, warnings, results: [...candidates.values()].sort((a,b) => b.score-a.score).slice(0,limit).map(r => {
      const item = eligible.get(r.id)!;
      return { ...r, title: item.title, kind: item.kind, created: item.created, source: item.source,
        url: item.kind === 'url' ? item.original : null,
        assetPath: item.asset ? join(this.home,'assets',item.asset) : null,
        reason: [r.keyword ? 'Keyword match in saved content or context' : '', r.similarity !== null ? `Semantic similarity ${r.similarity.toFixed(3)}` : ''].filter(Boolean).join('; ') };
    }) };
  }
  status() {
    const items = this.list();
    return { home: this.home, count: items.length, semantic: this.config.semantic, model: this.config.semantic ? this.embedder.name : null,
      capturePending: items.filter(i=>i.capture==='pending').length, captureFailed: items.filter(i=>i.capture==='failed').length,
      indexPending: items.filter(i=>i.indexing==='pending' || (this.config.semantic && i.indexing==='disabled')).length,
      indexFailed: items.filter(i=>i.indexing==='failed').length,
      failures: items.filter(i=>i.captureError || i.indexError).map(i=>({id:i.id,captureError:i.captureError,indexError:i.indexError})) };
  }
  delete(id: string) {
    const item=this.get(id);
    this.transaction(() => { this.db.prepare('DELETE FROM items WHERE id=?').run(id); });
    // Commit metadata deletion first; cleanup failure must not resurrect an item with missing bytes.
    let cleanupError: string|null=null;
    try { this.transaction(() => {
      if(item.asset && !this.list().some(i=>i.asset===item.asset)) rmSync(join(this.home,'assets',item.asset),{force:true});
    }); } catch(e) {cleanupError=errorText(e);}
    return { deleted: id, cleanupError };
  }
  async reindex() {
    this.transaction(() => {
      this.db.exec('DELETE FROM search; DELETE FROM chunks;');
      for (const item of this.list()) { this.buildChunks(item); item.indexing = this.config.semantic ? 'pending' : 'disabled'; item.indexError = null; this.update(item); }
    });
    for (const item of this.list()) if (this.config.semantic) await this.process(item.id);
    return this.status();
  }
  export(destination: string) {
    const target = resolve(destination);
    if (within(target, this.home) || within(this.home, target)) throw new Error('Export destination must be separate from the collection.');
    if (existsSync(target)) throw new Error('Export destination already exists; choose a new directory.');
    return this.transaction(() => {
      mkdirSync(join(target,'assets'), {recursive:true,mode:0o700});
      const items = this.list();
      atomicWrite(join(target,'records.json'), JSON.stringify({version:1, items},null,2));
      for (const asset of new Set(items.map(i=>i.asset).filter((v):v is string=>Boolean(v)))) copyFileSync(join(this.home,'assets',asset),join(target,'assets',asset));
      return { destination: target, count: items.length };
    });
  }
  import(directory: string) {
    const root=realpathSync(directory);
    const recordSchema=z.object({
      id:z.string().regex(/^m_[a-f0-9]{32}$/),kind:z.enum(['note','url','file']),title:z.string().max(500),original:z.string().max(1_000_000),
      note:z.string().max(20_000),description:z.string().max(20_000),source:z.string().max(1000),created:z.string().datetime(),updated:z.string().datetime(),
      text:z.string().max(5_000_000),asset:z.string().regex(/^[a-f0-9]{64}(\.[a-z0-9]{1,11})?$/).nullable(),
      capture:z.enum(['pending','ready','failed']),captureError:z.string().nullable(),indexing:z.enum(['pending','ready','disabled','failed']),indexError:z.string().nullable(),
      hash:z.string().regex(/^[a-f0-9]{64}$/),finalUrl:z.string().nullable(),capturedAt:z.string().datetime().nullable(),
    });
    const manifest=join(root,'records.json');
    if(statSync(manifest).size>100*1024*1024)throw new Error('Import manifest exceeds 100 MB.');
    const {items}=z.object({version:z.literal(1),items:z.array(recordSchema).max(100_000)}).parse(JSON.parse(readFileSync(manifest,'utf8')));
    const assets=new Map<string,Buffer>();
    for(const item of items) if(item.asset && !assets.has(item.asset)) {
      const path=realpathSync(join(root,'assets',item.asset));
      if(!within(path,root) || statSync(path).size>20*1024*1024)throw new Error('Invalid import asset path or size.');
      const bytes=readFileSync(path);
      if(!item.asset.startsWith(hash(bytes)))throw new Error('Import asset content hash mismatch.');
      assets.set(item.asset,bytes);
    }
    return this.transaction(()=>{
      let imported=0,duplicates=0;
      for(const item of items) {
        if(this.db.prepare('SELECT id FROM items WHERE hash=?').get(item.hash)){duplicates++;continue;}
        if(this.db.prepare('SELECT id FROM items WHERE id=?').get(item.id))throw new Error(`Import ID collision: ${item.id}`);
        if(item.asset && !existsSync(join(this.home,'assets',item.asset)))atomicWrite(join(this.home,'assets',item.asset),assets.get(item.asset)!);
        item.indexing=this.config.semantic?'pending':'disabled';item.indexError=null;
        this.db.prepare('INSERT INTO items VALUES(?,?,?)').run(item.id,item.hash,JSON.stringify(item));
        this.buildChunks(item);imported++;
      }
      return {imported,duplicates,next:this.config.semantic?'Run memlio retry to generate embeddings.':null};
    });
  }
  async close() { this.db.close(); await this.embedder.dispose(); }
}
