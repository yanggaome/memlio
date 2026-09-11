import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { Memory } from '../dist/store.js';
import { loadConfig } from '../dist/config.js';
import { extractPage, isPublicAddress, publicTarget } from '../dist/capture.js';

const exec = promisify(execFile);
const cli = resolve('dist/cli.js');
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'memlio-test-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
// In-process tests inject a trivial embedder so they never load the real model.
const fakeEmbedder = (calls = []) => ({
  name: 'test-model',
  embed: async (texts) => {
    calls.push(...texts);
    return texts.map(() => [1, 0]);
  },
  dispose: async () => {},
});
// Similarity depends on shared words, so unrelated queries score zero.
const wordEmbedder = (calls = []) => ({
  name: 'word-model',
  embed: async (texts) => {
    calls.push(...texts);
    return texts.map((text) => {
      const vector = new Array(64).fill(0);
      for (const word of text.toLowerCase().match(/[a-z]+/g) ?? [])
        vector[[...word].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 64, 7)] += 1;
      return vector;
    });
  },
  dispose: async () => {},
});
const failingEmbedder = () => ({
  name: 'failing',
  embed: async () => {
    throw new Error('provider offline');
  },
  dispose: async () => {},
});
function memoryOf(t, home, embedder = fakeEmbedder()) {
  const memory = new Memory(home, embedder);
  t.after(() => memory.close());
  return memory;
}
// CLI subprocesses run offline with an empty model cache: embedding fails fast and keyword search takes over.
const offline = (root) => ({ env: { ...process.env, MEMLIO_OFFLINE: '1', MEMLIO_MODEL_CACHE: join(root, 'no-models') } });
async function run(root, home, ...args) {
  const { stdout } = await exec(process.execPath, [cli, '--home', home, '--json', ...args], offline(root));
  return JSON.parse(stdout);
}

test('a fresh collection embeds on save and searches in hybrid mode', async (t) => {
  const calls = [];
  const memory = memoryOf(t, fixture(t), fakeEmbedder(calls));
  const saved = await memory.store({ input: 'Use a password manager' });
  assert.equal(saved.item.indexing, 'ready');
  const result = await memory.search('protect online accounts');
  assert.equal(result.mode, 'hybrid');
  assert.equal(result.results[0].id, saved.item.id);
  assert.equal(result.results[0].keyword, false);
  assert.equal(calls.length, 2);
});

test('without a model, saves still succeed and search falls back to keyword with a warning', async (t) => {
  const root = fixture(t);
  const home = join(root, 'collection');
  const saved = await run(root, home, 'store', 'Remember the offline garden');
  assert.equal(saved.indexing, 'failed');
  assert.match(saved.indexError, /not downloaded/);
  const found = await run(root, home, 'find', 'garden');
  assert.equal(found.mode, 'keyword');
  assert.equal(found.results[0].id, saved.id);
  assert.match(found.warnings[0], /Semantic search unavailable/);
  const status = await run(root, home, 'status');
  assert.equal(status.indexFailed, 1);
  assert.match(status.next, /memlio repair/);
});

test('pending embeddings are completed lazily by the next search once the model is available', async (t) => {
  const home = fixture(t);
  const first = new Memory(home, failingEmbedder());
  const saved = await first.store({ input: 'Bread proofs overnight in the fridge' });
  assert.equal(saved.item.indexing, 'failed');
  await first.close();
  const second = memoryOf(t, home, fakeEmbedder());
  const result = await second.search('sourdough');
  assert.equal(result.mode, 'hybrid');
  assert.equal(second.get(saved.item.id).indexing, 'ready');
  assert.deepEqual(result.warnings, []);
});

test('CLI storage persists across processes and unrelated working directories', async (t) => {
  const root = fixture(t);
  const home = join(root, 'collection');
  const saved = await run(root, home, 'store', 'An orchard of rare apples', '--note', 'For my garden');
  const { stdout } = await exec(process.execPath, [cli, '--home', home, '--json', 'find', 'garden'], {
    ...offline(root),
    cwd: tmpdir(),
  });
  assert.equal(JSON.parse(stdout).results[0].id, saved.id);
  const item = await run(root, home, 'get', saved.id);
  assert.equal(item.original, 'An orchard of rare apples');
});

test('human output is readable and --json is machine readable', async (t) => {
  const root = fixture(t);
  const home = join(root, 'collection');
  const { stdout } = await exec(process.execPath, [cli, '--home', home, 'store', 'A plain text receipt'], offline(root));
  assert.match(stdout, /^Saved m_[a-f0-9]{32}: A plain text receipt\n  Semantic indexing failed: /);
  const status = await exec(process.execPath, [cli, '--home', home, 'status'], offline(root));
  assert.match(status.stdout, /^1 item in /);
});

test('concurrent first-start writers retain all notes', async (t) => {
  const root = fixture(t);
  const home = join(root, 'collection');
  await Promise.all(Array.from({ length: 8 }, (_, i) => run(root, home, 'store', `Independent writer ${i} unique record`)));
  assert.equal((await run(root, home, 'status')).count, 8);
});

test('concurrent duplicate saves create one item', async (t) => {
  const root = fixture(t);
  const home = join(root, 'collection');
  const saves = await Promise.all(Array.from({ length: 5 }, () => run(root, home, 'store', 'Identical thought')));
  assert.equal(new Set(saves.map((s) => s.id)).size, 1);
  assert.equal((await run(root, home, 'status')).count, 1);
});

test('file originals survive source deletion; MCP access is restricted to allowed folders', async (t) => {
  const root = fixture(t);
  const path = join(root, 'picture.png');
  writeFileSync(path, Buffer.from([137, 80, 78, 71, 1, 2, 3]));
  const memory = memoryOf(t, join(root, 'collection'));
  await assert.rejects(memory.store({ input: path }), /outside the folders/);
  await assert.rejects(memory.store({ input: join(root, 'missing.png') }, { explicit: true }), /File not found/);
  const saved = await memory.store({ input: path, description: 'Dark dashboard with orange charts' }, { roots: [root] });
  const original = readFileSync(path);
  rmSync(path);
  assert.deepEqual(readFileSync(join(memory.home, 'assets', saved.item.asset)), original);
  assert.equal((await memory.search('orange charts')).results[0].id, saved.item.id);
});

test('setup --allow-path records folders even when the model cannot be prepared', async (t) => {
  const root = fixture(t);
  const home = join(root, 'collection');
  const result = await run(root, home, 'setup', 'claude', '--target-home', root, '--allow-path', root);
  assert.deepEqual(loadConfig(home), { version: 1, allowedPaths: [root] });
  assert.match(result.model, /not downloaded/);
  assert.ok(existsSync(join(root, '.claude.json')));
});

test('failed URL capture preserves bookmark, context and error', async (t) => {
  const memory = memoryOf(t, fixture(t));
  const { item } = await memory.store({ input: 'http://127.0.0.1/private', note: 'Design archive' });
  assert.equal(item.capture, 'failed');
  assert.match(item.captureError, /blocked/);
  assert.equal(item.original, 'http://127.0.0.1/private');
  assert.equal((await memory.search('design archive')).results[0].id, item.id);
});

test('deferred URL remains visible with explicit pending capture state', async (t) => {
  const memory = memoryOf(t, fixture(t));
  const { item } = await memory.store({ input: 'https://example.com/article', defer: true, note: 'Lentil recipe' });
  assert.equal(item.capture, 'pending');
  assert.equal(memory.status().capturePending, 1);
  assert.equal((await memory.search('lentil')).results[0].id, item.id);
});

test('literal URL-shaped notes do not fetch', async (t) => {
  const memory = memoryOf(t, fixture(t));
  const { item } = await memory.store({ input: 'http://127.0.0.1/', kind: 'note' });
  assert.equal(item.kind, 'note');
  assert.equal(item.capture, 'ready');
});

test('readable snapshot extracts content and excludes scripts', () => {
  const article = 'This article describes durable execution, retries, and background task recovery. '.repeat(30);
  const result = extractPage(
    `<html><head><title>Reliable tasks</title></head><body><nav>Menu</nav><article><h1>Reliable tasks</h1><p>${article}</p></article><script>secretExecutable()</script></body></html>`,
    'https://example.com',
  );
  assert.equal(result.title, 'Reliable tasks');
  assert.match(result.markdown, /durable execution/);
  assert.doesNotMatch(result.markdown, /secretExecutable/);
});

test('public destination policy rejects private and alternate IP representations', async () => {
  for (const ip of [
    '127.0.0.1',
    '10.0.0.1',
    '192.168.1.3',
    '172.16.0.2',
    '169.254.169.254',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fe80::1',
    '0.0.0.0',
    '224.0.0.1',
  ]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  assert.equal(isPublicAddress('1.1.1.1'), true);
  await assert.rejects(publicTarget('http://2130706433/'), /blocked/);
  await assert.rejects(publicTarget('https://user:pass@example.com'), /credentials/);
  await assert.rejects(publicTarget('file:///etc/passwd'), /HTTP/);
});

test('repair rebuilds the keyword index, keeps existing vectors, and deletion removes hits', async (t) => {
  const calls = [];
  const memory = memoryOf(t, fixture(t), wordEmbedder(calls));
  const { item } = await memory.store({ input: 'A telescope for observing Saturn' });
  memory.db.exec('DELETE FROM search');
  assert.equal((await memory.search('telescope')).results[0].keyword, false, 'only the semantic branch finds it');
  const embedsBefore = calls.length;
  await memory.repair();
  const [found] = (await memory.search('telescope')).results;
  assert.equal(found.id, item.id);
  assert.equal(found.keyword, true);
  assert.equal(calls.length - embedsBefore, 1, 'repair re-embeds nothing; only the query is embedded');
  memory.delete(item.id);
  assert.equal((await memory.search('telescope')).results.length, 0);
  assert.throws(() => memory.get(item.id), /not found/);
});

test('long notes do not crowd the body out of chunks', async (t) => {
  const memory = memoryOf(t, fixture(t));
  const { item } = await memory.store({ input: 'body text about telescopes', note: 'x'.repeat(5000) });
  const { text } = memory.db.prepare('SELECT text FROM chunks WHERE item_id=?').get(item.id);
  assert.ok(text.length < 1300);
  assert.match(text, /telescopes/);
});

test('deleting one reference preserves a shared asset', async (t) => {
  const root = fixture(t);
  const path = join(root, 'photo.png');
  writeFileSync(path, 'image bytes');
  const memory = memoryOf(t, join(root, 'collection'));
  const a = await memory.store({ input: path, note: 'first' }, { explicit: true });
  const b = await memory.store({ input: path, note: 'second' }, { explicit: true });
  const asset = join(memory.home, 'assets', a.item.asset);
  memory.delete(a.item.id);
  assert.ok(existsSync(asset));
  memory.delete(b.item.id);
  assert.equal(existsSync(asset), false);
});

test('export and import preserve IDs, original bytes and searchability, and embed on import', async (t) => {
  const root = fixture(t);
  const path = join(root, 'sketch.png');
  writeFileSync(path, 'sketch bytes');
  const first = memoryOf(t, join(root, 'first'));
  const second = memoryOf(t, join(root, 'second'));
  const saved = await first.store({ input: path, description: 'Blue kitchen shelves' }, { explicit: true });
  first.export(join(root, 'backup'));
  const imported = await second.import(join(root, 'backup'));
  assert.equal(imported.imported, 1);
  assert.equal(imported.indexPending, 0);
  assert.equal(second.get(saved.item.id).description, 'Blue kitchen shelves');
  assert.equal(second.get(saved.item.id).indexing, 'ready');
  assert.equal(readFileSync(join(second.home, 'assets', saved.item.asset), 'utf8'), 'sketch bytes');
  assert.equal((await second.search('kitchen')).results[0].id, saved.item.id);
  assert.equal((await second.import(join(root, 'backup'))).duplicates, 1);
  await assert.rejects(second.import(root), /records\.json/);
});

test('import rejects asset path traversal before changing catalog', async (t) => {
  const root = fixture(t);
  const memory = memoryOf(t, join(root, 'first'));
  await memory.store({ input: 'hello' });
  memory.export(join(root, 'backup'));
  const file = join(root, 'backup', 'records.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  manifest.items[0].asset = '../secret';
  writeFileSync(file, JSON.stringify(manifest));
  await assert.rejects(memory.import(join(root, 'backup')));
  assert.equal(memory.status().count, 1);
});

test('embedding failure does not lose a saved note', async (t) => {
  const memory = memoryOf(t, fixture(t), failingEmbedder());
  const saved = await memory.store({ input: 'Preserve this even offline' });
  assert.equal(saved.item.indexing, 'failed');
  assert.equal(saved.item.indexError, 'provider offline');
  const result = await memory.search('preserve');
  assert.equal(result.mode, 'keyword');
  assert.equal(result.results[0].id, saved.item.id);
  assert.match(result.warnings[0], /provider offline/);
});

test('unrelated search has no hits and bad limits are rejected', async (t) => {
  const memory = memoryOf(t, fixture(t), wordEmbedder());
  await memory.store({ input: 'Grow tomatoes' });
  assert.equal((await memory.search('interplanetary spaceships')).results.length, 0);
  await assert.rejects(memory.search('plants', { limit: -1 }), /Limit/);
});

test('type and date filters scope retrieval', async (t) => {
  const memory = memoryOf(t, fixture(t));
  await memory.store({ input: 'coffee beans' });
  await memory.store({ input: 'https://example.com/coffee', note: 'coffee', defer: true });
  assert.equal((await memory.search('coffee', { kind: 'url' })).results.length, 1);
  assert.equal((await memory.search('coffee', { before: '2000-01-01' })).results.length, 0);
});
