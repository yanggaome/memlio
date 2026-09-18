import { existsSync, readFileSync, mkdirSync, copyFileSync, chmodSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import TOML from '@iarna/toml';
import { atomicWrite } from './config.js';
import { HOST_NAME } from './native.js';

const start = '# BEGIN memlio managed server';
const end = '# END memlio managed server';
const marker = '<!-- memlio-local managed skill -->';

export interface SetupOptions {
  targetHome?: string;
  dryRun?: boolean;
  /** Chrome only: the ID chrome://extensions shows, when it differs from the one derived from the bundled key. */
  extensionId?: string;
}

/** Register memlio with one client: an MCP server and skill for an agent, or a native messaging host for Chrome. */
export function setup(client: string, home: string, options: SetupOptions = {}) {
  if (client === 'chrome') return setupChrome(home, options);
  if (!['codex', 'claude', 'copilot'].includes(client)) throw new Error('Choose codex, claude, copilot, or chrome.');
  return setupAgent(client, home, options);
}

/** Chrome derives an extension's ID from the public key in its manifest: the first 32 hex digits of the key's SHA-256, written with the letters a to p. */
export function extensionIdFromKey(key: string): string {
  const digest = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex');
  return [...digest.slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

/** The unpacked extension shipped with the package. */
export const extensionPath = () => fileURLToPath(new URL('../extension', import.meta.url));

/** Write the launcher Chrome runs and the host manifest that lets the extension reach it. */
function setupChrome(home: string, options: SetupOptions) {
  if (process.platform === 'win32') throw new Error('Chrome setup is not supported on Windows yet.');
  const userHome = resolve(options.targetHome ?? homedir());
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
  const extension = extensionPath();
  const manifest = JSON.parse(readFileSync(join(extension, 'manifest.json'), 'utf8')) as { key?: unknown };
  if (!options.extensionId && typeof manifest.key !== 'string') {
    throw new Error('The extension manifest has no key; pass --extension-id with the ID chrome://extensions shows.');
  }
  const extensionId = options.extensionId ?? extensionIdFromKey(manifest.key as string);
  if (!/^[a-p]{32}$/.test(extensionId)) throw new Error('Extension IDs are 32 letters from a to p.');
  const hostsDir =
    process.platform === 'darwin'
      ? join(userHome, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts')
      : join(userHome, '.config', 'google-chrome', 'NativeMessagingHosts');
  const manifestPath = join(hostsDir, `${HOST_NAME}.json`);
  // Chrome needs an executable, so a shell script carries the Node path, the CLI, and the collection directory.
  const launcherPath = join(home, 'chrome-host.sh');
  const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
  const launcher = `#!/bin/sh\n# Written by memlio setup chrome. Chrome starts this to reach the local collection.\nexec ${quote(process.execPath)} ${quote(cli)} --home ${quote(home)} chrome-host\n`;
  const hostManifest =
    JSON.stringify(
      {
        name: HOST_NAME,
        description: 'Memlio: save the current tab into the local collection',
        path: launcherPath,
        type: 'stdio',
        allowed_origins: [`chrome-extension://${extensionId}/`],
      },
      null,
      2,
    ) + '\n';
  if (!options.dryRun) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(hostsDir, { recursive: true });
    atomicWrite(launcherPath, launcher);
    chmodSync(launcherPath, 0o755);
    atomicWrite(manifestPath, hostManifest);
  }
  return {
    client: 'chrome' as const,
    manifestPath,
    launcherPath,
    extensionPath: extension,
    extensionId,
    dryRun: Boolean(options.dryRun),
  };
}

/** Register the MCP server and install the skill in one client's user-level configuration. */
function setupAgent(client: string, home: string, options: SetupOptions) {
  const userHome = resolve(options.targetHome ?? homedir());
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
  const server = { command: process.execPath, args: [cli, '--home', home, 'mcp'] };
  // Copilot CLI keeps its files under COPILOT_HOME when that is set; an explicit target home wins so tests stay hermetic.
  const copilotHome = options.targetHome
    ? join(userHome, '.copilot')
    : resolve(process.env.COPILOT_HOME ?? join(userHome, '.copilot'));
  const paths = {
    codex: { config: join(userHome, '.codex', 'config.toml'), skills: join(userHome, '.agents', 'skills') },
    claude: { config: join(userHome, '.claude.json'), skills: join(userHome, '.claude', 'skills') },
    copilot: { config: join(copilotHome, 'mcp-config.json'), skills: join(copilotHome, 'skills') },
  }[client as 'codex' | 'claude' | 'copilot'];
  const configPath = paths.config;
  const skillPath = join(paths.skills, 'memlio', 'SKILL.md');
  const original = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  let config: string;
  if (client === 'codex') {
    const parsed = TOML.parse(original) as any;
    if (parsed.mcp_servers?.memlio && !original.includes(start)) {
      throw new Error('An unmanaged Codex MCP server named memlio already exists. Rename it before setup.');
    }
    const block = `${start}\n[mcp_servers.memlio]\ncommand = ${JSON.stringify(server.command)}\nargs = ${JSON.stringify(server.args)}\n${end}`;
    if (original.includes(start)) {
      const begin = original.indexOf(start);
      const finish = original.indexOf(end, begin);
      if (finish < 0) throw new Error('Incomplete managed configuration block; repair it before setup.');
      config = original.slice(0, begin) + block + original.slice(finish + end.length);
    } else config = original.trimEnd() + '\n\n' + block + '\n';
    TOML.parse(config);
  } else {
    const parsed = original ? JSON.parse(original) : {};
    if (parsed.mcpServers?.memlio && !parsed.mcpServers.memlio.args?.some((a: string) => a === cli)) {
      throw new Error(`An existing ${client} MCP server named memlio has different configuration. Rename it before setup.`);
    }
    parsed.mcpServers ??= {};
    // Copilot CLI expects type "local" and an explicit tool allowlist; Claude Code expects type "stdio".
    parsed.mcpServers.memlio = client === 'copilot' ? { type: 'local', ...server, tools: ['*'] } : { type: 'stdio', ...server };
    config = JSON.stringify(parsed, null, 2) + '\n';
  }
  const skill = readFileSync(fileURLToPath(new URL(`../skills/${client}/memlio/SKILL.md`, import.meta.url)), 'utf8');
  if (existsSync(skillPath) && !readFileSync(skillPath, 'utf8').includes(marker)) {
    throw new Error(`An unmanaged skill exists at ${skillPath}.`);
  }
  if (!options.dryRun) {
    mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
    mkdirSync(dirname(skillPath), { recursive: true, mode: 0o700 });
    // One backup, overwritten on each run, so repeated setups do not litter the home directory.
    if (original) copyFileSync(configPath, `${configPath}.memlio-backup`);
    atomicWrite(configPath, config);
    atomicWrite(skillPath, skill);
  }
  return { client: client as 'codex' | 'claude' | 'copilot', configPath, skillPath, server, dryRun: Boolean(options.dryRun) };
}
