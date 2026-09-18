import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import TOML from '@iarna/toml';
import { setup, extensionIdFromKey } from '../dist/setup.js';
import { Memory } from '../dist/store.js';
import { encode, decode } from '../dist/native.js';
import { PNG_1X1, REAL_CLIPBOARD, putPngOnClipboard, connectMcp, offline, exec } from './helpers.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'memlio-integration-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('Codex setup preserves existing settings/comments and is idempotent', (t) => {
  const root = fixture(t);
  mkdirSync(join(root, '.codex'));
  writeFileSync(join(root, '.codex', 'config.toml'), '# keep me\nmodel = "custom"\n[mcp_servers.other]\ncommand = "other"\n');
  setup('codex', join(root, 'collection'), { targetHome: root });
  setup('codex', join(root, 'collection'), { targetHome: root });
  const text = readFileSync(join(root, '.codex', 'config.toml'), 'utf8');
  const parsed = TOML.parse(text);
  assert.match(text, /# keep me/);
  assert.equal(parsed.model, 'custom');
  assert.equal(parsed.mcp_servers.other.command, 'other');
  assert.equal(parsed.mcp_servers.memlio.command, process.execPath);
  assert.equal(text.split('[mcp_servers.memlio]').length, 2);
});

test('Claude setup merges settings, keeps one backup, and dry-run leaves files unchanged', (t) => {
  const root = fixture(t);
  writeFileSync(join(root, '.claude.json'), JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'other' } } }));
  setup('claude', join(root, 'collection'), { targetHome: root, dryRun: true });
  assert.equal(JSON.parse(readFileSync(join(root, '.claude.json'), 'utf8')).mcpServers.memlio, undefined);
  setup('claude', join(root, 'collection'), { targetHome: root });
  setup('claude', join(root, 'collection'), { targetHome: root });
  const parsed = JSON.parse(readFileSync(join(root, '.claude.json'), 'utf8'));
  assert.equal(parsed.theme, 'dark');
  assert.equal(parsed.mcpServers.other.command, 'other');
  assert.equal(parsed.mcpServers.memlio.type, 'stdio');
  assert.ok(existsSync(join(root, '.claude.json.memlio-backup')));
  assert.equal(
    readFileSync(join(root, '.claude', 'skills', 'memlio', 'SKILL.md'), 'utf8').includes('memlio-local managed skill'),
    true,
  );
});

test('Copilot setup writes mcp-config.json with a local server and installs the skill under .copilot', (t) => {
  const root = fixture(t);
  mkdirSync(join(root, '.copilot'));
  writeFileSync(join(root, '.copilot', 'mcp-config.json'), JSON.stringify({ mcpServers: { other: { command: 'other' } } }));
  setup('copilot', join(root, 'collection'), { targetHome: root, dryRun: true });
  assert.equal(JSON.parse(readFileSync(join(root, '.copilot', 'mcp-config.json'), 'utf8')).mcpServers.memlio, undefined);
  setup('copilot', join(root, 'collection'), { targetHome: root });
  setup('copilot', join(root, 'collection'), { targetHome: root });
  const parsed = JSON.parse(readFileSync(join(root, '.copilot', 'mcp-config.json'), 'utf8'));
  assert.equal(parsed.mcpServers.other.command, 'other');
  assert.equal(parsed.mcpServers.memlio.type, 'local');
  assert.deepEqual(parsed.mcpServers.memlio.tools, ['*']);
  assert.equal(parsed.mcpServers.memlio.command, process.execPath);
  assert.ok(parsed.mcpServers.memlio.args.includes('mcp'));
  assert.ok(existsSync(join(root, '.copilot', 'mcp-config.json.memlio-backup')));
  const installed = readFileSync(join(root, '.copilot', 'skills', 'memlio', 'SKILL.md'), 'utf8');
  assert.ok(installed.includes('memlio-local managed skill'));
  assert.ok(installed.includes('memlio setup copilot'));
  assert.ok(!existsSync(join(root, '.agents')));
});

test('setup refuses to replace an unrelated existing memlio server', (t) => {
  const root = fixture(t);
  writeFileSync(join(root, '.claude.json'), JSON.stringify({ mcpServers: { memlio: { command: 'someone-else' } } }));
  assert.throws(() => setup('claude', root, { targetHome: root }), /existing/);
});

test('real MCP SDK client stores, searches and reads across fresh servers', async (t) => {
  const root = fixture(t);
  const home = join(root, 'collection');
  const first = await connectMcp(root, home);
  let id;
  try {
    const tools = await first.listTools();
    assert.deepEqual(tools.tools.map((x) => x.name).sort(), [
      'memlio_delete',
      'memlio_get',
      'memlio_search',
      'memlio_status',
      'memlio_store',
    ]);
    const response = await first.callTool({
      name: 'memlio_store',
      arguments: { input: 'A travel adapter for Japan', note: 'Packing list' },
    });
    assert.ok(!response.isError);
    id = JSON.parse(response.content[0].text).id;
  } finally {
    await first.close();
  }
  const second = await connectMcp(root, home);
  try {
    const response = await second.callTool({ name: 'memlio_search', arguments: { query: 'packing' } });
    const found = JSON.parse(response.content[0].text);
    assert.equal(found.results[0].id, id);
    assert.equal(found.mode, 'keyword');
    const read = await second.callTool({ name: 'memlio_get', arguments: { id, maxChars: 10 } });
    assert.equal(JSON.parse(read.content[0].text).text.length, 10);
    assert.equal(JSON.parse(read.content[0].text).nextOffset, 10);
    const bad = await second.callTool({ name: 'memlio_store', arguments: { input: '/etc/hosts', kind: 'file' } });
    assert.equal(bad.isError, true);
    const store = (await second.listTools()).tools.find((x) => x.name === 'memlio_store');
    assert.equal(store.inputSchema.properties.clipboard.type, 'boolean');
    assert.ok(!store.inputSchema.required?.includes('input'));
    const empty = await second.callTool({ name: 'memlio_store', arguments: {} });
    assert.equal(empty.isError, true);
    assert.match(JSON.parse(empty.content[0].text).error, /non-empty/);
  } finally {
    await second.close();
  }
  const memory = new Memory(home);
  assert.equal(memory.status().count, 1);
  await memory.close();
});

test('MCP clipboard store echoes the saved image', REAL_CLIPBOARD, async (t) => {
  const root = fixture(t);
  const home = join(root, 'collection');
  const png = PNG_1X1;
  await putPngOnClipboard(root);
  const client = await connectMcp(root, home);
  try {
    const response = await client.callTool({
      name: 'memlio_store',
      arguments: { clipboard: true, description: 'single white pixel', note: 'clipboard test' },
    });
    assert.ok(!response.isError, JSON.stringify(response.content));
    const summary = JSON.parse(response.content[0].text);
    assert.deepEqual(summary.image, { width: 1, height: 1, bytes: png.length, mediaType: 'image/png' });
    assert.equal(summary.echoed, true);
    assert.equal(response.content[1].type, 'image');
    assert.equal(response.content[1].mimeType, 'image/png');
    assert.deepEqual(Buffer.from(response.content[1].data, 'base64'), png);
    // A duplicate paste is not echoed again; the summary still identifies the image.
    const again = await client.callTool({
      name: 'memlio_store',
      arguments: { clipboard: true, description: 'single white pixel', note: 'clipboard test' },
    });
    const repeat = JSON.parse(again.content[0].text);
    assert.equal(repeat.duplicate, true);
    assert.equal(repeat.echoed, false);
    assert.equal(again.content.length, 1);
    const read = await client.callTool({ name: 'memlio_get', arguments: { id: summary.id } });
    assert.equal(JSON.parse(read.content[0].text).original, undefined);
  } finally {
    await client.close();
  }
});

/** Runs a native messaging host to completion and returns its decoded replies. */
async function nativeSession(command, args, env, requests) {
  const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const out = [];
  const err = [];
  child.stdout.on('data', (c) => out.push(c));
  child.stderr.on('data', (c) => err.push(c));
  for (const request of requests) child.stdin.write(encode(request));
  child.stdin.end();
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 0, Buffer.concat(err).toString());
  const { messages, rest } = decode(Buffer.concat(out));
  assert.equal(rest.length, 0);
  return messages;
}

test('native messaging frames survive arbitrary chunk boundaries and oversized frames are refused', () => {
  const frames = Buffer.concat([encode({ a: 1 }), encode({ b: 'two' }), encode({ c: [3] })]);
  const all = [];
  let rest = Buffer.alloc(0);
  for (let cut = 0; cut < frames.length; cut += 5) {
    const decoded = decode(Buffer.concat([rest, frames.subarray(cut, cut + 5)]));
    all.push(...decoded.messages);
    rest = decoded.rest;
  }
  assert.deepEqual(all, [{ a: 1 }, { b: 'two' }, { c: [3] }]);
  assert.equal(rest.length, 0);
  assert.throws(() => decode(encode({ big: 'x'.repeat(10) }), 8), /exceeds/);
});

test('the Chrome host answers framed requests in order and saves a captured page with its screenshot', async (t) => {
  const root = fixture(t);
  const home = join(root, 'collection');
  const html = `<html><head><title>Reliable tasks</title></head><body><article><h1>Reliable tasks</h1><p>${'Durable execution and retries. '.repeat(30)}</p></article></body></html>`;
  const replies = await nativeSession(process.execPath, [resolve('dist/cli.js'), '--home', home, 'chrome-host'], offline(root), [
    { type: 'status' },
    { type: 'nonsense' },
    {
      type: 'store',
      url: 'https://example.com/tasks',
      title: 'Tab',
      note: 'queue project',
      html,
      text: 'fallback',
      screenshot: PNG_1X1.toString('base64'),
    },
    { type: 'store', url: 'ftp://example.com/tasks', html },
  ]);
  assert.equal(replies.length, 4);
  assert.equal(replies[0].ok, true);
  assert.equal(replies[0].count, 0);
  assert.equal(replies[0].home, home);
  assert.deepEqual(replies[1], { ok: false, error: 'Invalid request.' });
  assert.equal(replies[2].ok, true);
  assert.equal(replies[2].capture, 'ready');
  assert.equal(replies[2].title, 'Reliable tasks');
  assert.equal(replies[2].image.width, 1);
  assert.equal(replies[3].ok, false);
  assert.match(replies[3].error, /HTTP/);
  const { stdout } = await exec(process.execPath, [resolve('dist/cli.js'), '--home', home, '--json', 'get', replies[2].id], {
    env: offline(root),
  });
  const item = JSON.parse(stdout);
  assert.equal(item.source, 'chrome');
  assert.equal(item.note, 'queue project');
  assert.match(item.text, /Durable execution/);
  assert.ok(existsSync(join(home, 'assets', item.asset)));
});

test('Chrome setup writes an executable launcher and a host manifest naming the bundled extension', async (t) => {
  const root = fixture(t);
  const home = join(root, 'collection');
  const dry = setup('chrome', home, { targetHome: root, dryRun: true });
  assert.ok(!existsSync(dry.manifestPath) && !existsSync(dry.launcherPath));
  const result = setup('chrome', home, { targetHome: root });
  setup('chrome', home, { targetHome: root });
  assert.ok(result.manifestPath.startsWith(root));
  const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8'));
  const key = JSON.parse(readFileSync(join(result.extensionPath, 'manifest.json'), 'utf8')).key;
  assert.match(result.extensionId, /^[a-p]{32}$/);
  assert.equal(result.extensionId, extensionIdFromKey(key));
  assert.equal(manifest.name, 'com.memlio.host');
  assert.equal(manifest.type, 'stdio');
  assert.equal(manifest.path, result.launcherPath);
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${result.extensionId}/`]);
  assert.ok(statSync(result.launcherPath).mode & 0o100);
  // Chrome runs the launcher directly; it must reach the right collection.
  const [status] = await nativeSession(result.launcherPath, [], offline(root), [{ type: 'status' }]);
  assert.equal(status.ok, true);
  assert.equal(status.home, home);
  const custom = setup('chrome', home, { targetHome: root, extensionId: 'abcdefghijklmnopabcdefghijklmnop' });
  assert.deepEqual(JSON.parse(readFileSync(custom.manifestPath, 'utf8')).allowed_origins, [
    'chrome-extension://abcdefghijklmnopabcdefghijklmnop/',
  ]);
  assert.throws(() => setup('chrome', home, { targetHome: root, extensionId: 'nope' }), /32 letters/);
  assert.throws(() => setup('firefox', home, { targetHome: root }), /chrome/);
});
