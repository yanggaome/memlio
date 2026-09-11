import { existsSync, readFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import TOML from '@iarna/toml';
import { atomicWrite } from './config.js';

const start = '# BEGIN memlio managed server';
const end = '# END memlio managed server';
const marker = '<!-- memlio-local managed skill -->';

/** Register the MCP server and install the skill in one client's user-level configuration. */
export function setup(client: string, home: string, options: { targetHome?: string; dryRun?: boolean } = {}) {
  if (!['codex', 'claude'].includes(client)) throw new Error('Choose codex or claude.');
  const userHome = resolve(options.targetHome ?? homedir());
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
  const server = { command: process.execPath, args: [cli, '--home', home, 'mcp'] };
  const configPath = client === 'codex' ? join(userHome, '.codex', 'config.toml') : join(userHome, '.claude.json');
  const skillPath = join(userHome, client === 'codex' ? '.agents' : '.claude', 'skills', 'memlio', 'SKILL.md');
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
      throw new Error('An existing Claude MCP server named memlio has different configuration. Rename it before setup.');
    }
    parsed.mcpServers ??= {};
    parsed.mcpServers.memlio = { type: 'stdio', ...server };
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
  return { client, configPath, skillPath, server, dryRun: Boolean(options.dryRun) };
}
