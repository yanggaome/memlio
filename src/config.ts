import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, openSync, fsyncSync, closeSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const VERSION = '0.2.0';
export const MODEL = 'Xenova/all-MiniLM-L6-v2';

const schema = z.object({
  version: z.literal(1),
  allowedPaths: z.array(z.string()).default([]),
});
export type Config = z.infer<typeof schema>;

export function dataHome(path?: string): string {
  return resolve(path ?? process.env.MEMLIO_HOME ?? join(homedir(), '.local', 'share', 'memlio'));
}

/** Write a file atomically: temp file, fsync, rename, fsync the directory. */
export function atomicWrite(path: string, data: string | Buffer): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const file = openSync(temp, 'wx', 0o600);
    try {
      writeFileSync(file, data);
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(temp, path);
    // Windows cannot fsync a directory handle; the rename is already durable enough there.
    if (process.platform !== 'win32') {
      const directory = openSync(dirname(path), 'r');
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    }
  } finally {
    rmSync(temp, { force: true });
  }
}

export function loadConfig(home: string): Config {
  const path = join(home, 'config.json');
  // Unknown keys from older versions (for example `semantic`) are dropped.
  return existsSync(path) ? schema.parse(JSON.parse(readFileSync(path, 'utf8'))) : schema.parse({ version: 1 });
}

export function saveConfig(home: string, config: Config): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  atomicWrite(join(home, 'config.json'), JSON.stringify(schema.parse(config), null, 2) + '\n');
}
