import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

// Opt in with an already downloaded model; this test never uses the network.
test('cached local model saves and retrieves a paraphrase across offline CLI processes', {
  skip: !process.env.MEMLIO_MODEL_CACHE,
}, t => {
  const root = mkdtempSync(join(tmpdir(), 'memlio-semantic-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'collection');
  const run = (...args) => {
    const result = spawnSync(process.execPath, [resolve('dist/cli.js'), '--home', home, '--json', ...args], {
      cwd: tmpdir(), encoding: 'utf8', env: { ...process.env, MEMLIO_OFFLINE: '1' }, timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.equal(run('init', '--semantic').semantic, true);
  const saved = run('store', 'Use a password manager to generate unique credentials and enable two-factor authentication.');
  assert.equal(saved.indexing, 'ready');
  const retrieved = run('retrieve', 'secure my online accounts', '--mode', 'semantic');
  assert.equal(retrieved.results[0]?.id, saved.id);
  assert.ok(retrieved.results[0].similarity > 0.25);
});
