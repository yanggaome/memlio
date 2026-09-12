import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export const exec = promisify(execFile);

/** A valid 1×1 PNG, small enough to keep in the tests and accepted by real clipboards. */
export const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** Real-clipboard tests replace the macOS clipboard, so they run only when opted in with MEMLIO_CLIPBOARD_TEST=1. */
export const REAL_CLIPBOARD = { skip: process.platform !== 'darwin' || !process.env.MEMLIO_CLIPBOARD_TEST };

/** Puts the 1×1 PNG on the macOS clipboard. */
export async function putPngOnClipboard(root) {
  const source = join(root, 'source.png');
  writeFileSync(source, PNG_1X1);
  await exec('osascript', ['-e', `set the clipboard to (read (POSIX file "${source}") as «class PNGf»)`]);
}

/** Subprocesses run offline with an empty model cache: embedding fails fast and keyword search takes over. */
export const offline = (root) => ({ ...process.env, MEMLIO_OFFLINE: '1', MEMLIO_MODEL_CACHE: join(root, 'no-models') });

/** Starts a fresh memlio MCP server on `home` and returns a connected SDK client. */
export async function connectMcp(root, home) {
  const client = new Client({ name: 'memlio-test', version: '1.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [resolve('dist/cli.js'), '--home', home, 'mcp'],
      env: offline(root),
      stderr: 'pipe',
    }),
  );
  return client;
}
