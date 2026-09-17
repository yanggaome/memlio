import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import TOML from '@iarna/toml';
import { setup } from '../dist/setup.js';
import { Memory } from '../dist/store.js';
import { PNG_1X1, REAL_CLIPBOARD, putPngOnClipboard, connectMcp } from './helpers.mjs';

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
