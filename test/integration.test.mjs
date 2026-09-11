import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import TOML from '@iarna/toml';
import { setup } from '../dist/setup.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Memory } from '../dist/store.js';

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

test('setup refuses to replace an unrelated existing memlio server', (t) => {
  const root = fixture(t);
  writeFileSync(join(root, '.claude.json'), JSON.stringify({ mcpServers: { memlio: { command: 'someone-else' } } }));
  assert.throws(() => setup('claude', root, { targetHome: root }), /existing/);
});

test('real MCP SDK client stores, searches and reads across fresh servers', async (t) => {
  const root = fixture(t);
  const home = join(root, 'collection');
  const env = { ...process.env, MEMLIO_OFFLINE: '1', MEMLIO_MODEL_CACHE: join(root, 'no-models') };
  async function connect() {
    const client = new Client({ name: 'memlio-test', version: '1.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [resolve('dist/cli.js'), '--home', home, 'mcp'],
        env,
        stderr: 'pipe',
      }),
    );
    return client;
  }
  const first = await connect();
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
  const second = await connect();
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
  } finally {
    await second.close();
  }
  const memory = new Memory(home);
  assert.equal(memory.status().count, 1);
  await memory.close();
});
