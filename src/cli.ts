#!/usr/bin/env node
import { Command, Option } from 'commander';
import { resolve } from 'node:path';
import { VERSION, dataHome, loadConfig, saveConfig } from './config.js';
import { Memory, summarize, type Summary } from './store.js';
import { LocalEmbedder } from './embedding.js';
import { setup } from './setup.js';
import { serve } from './mcp.js';

const program = new Command()
  .name('memlio')
  .version(VERSION)
  .description('Save something now. Find it later from a vague description.')
  .option('--home <directory>', 'Collection directory (also MEMLIO_HOME)')
  .option('--json', 'Machine-readable JSON output');
const home = () => dataHome(program.opts().home);
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function emit<T>(value: T, format: (value: T) => string) {
  console.log(program.opts().json ? JSON.stringify(value, null, 2) : format(value));
}
async function withMemory<T>(fn: (memory: Memory) => Promise<T> | T, format: (value: T) => string) {
  const memory = new Memory(home());
  try {
    emit(await fn(memory), format);
  } finally {
    await memory.close();
  }
}

type Status = ReturnType<Memory['status']>;
const formatSaved = (s: Summary) =>
  s.duplicate
    ? `Already saved as ${s.id}: ${s.title}`
    : [
        `Saved ${s.id}: ${s.title}`,
        s.image ? `  Image: ${s.image.width ?? '?'}×${s.image.height ?? '?'} PNG, ${(s.image.bytes / 1024).toFixed(0)} KB` : '',
        s.captureError ? `  Page capture failed: ${s.captureError}` : s.capture === 'pending' ? '  Page capture: pending' : '',
        s.indexError ? `  Semantic indexing failed: ${s.indexError}` : '',
      ]
        .filter(Boolean)
        .join('\n');
const formatStatus = (s: Status) =>
  [
    `${s.count} item${s.count === 1 ? '' : 's'} in ${s.home}`,
    s.capturePending || s.captureFailed ? `  Page capture: ${s.capturePending} pending, ${s.captureFailed} failed` : '',
    s.indexPending || s.indexFailed ? `  Semantic index: ${s.indexPending} pending, ${s.indexFailed} failed` : '',
    ...s.failures.slice(0, 20).map((f) => `  ${f.id} ${f.title}: ${f.captureError ?? f.indexError}`),
    s.next ?? 'Everything is captured and indexed.',
  ]
    .filter(Boolean)
    .join('\n');

program
  .command('setup')
  .description('Register the MCP server and skill with an agent, and prepare the local model')
  .argument('<client>', 'codex, claude, or copilot')
  .option('--allow-path <directory...>', 'Let the agent save files from these folders')
  .option('--dry-run', 'Preview paths and registration without changes')
  .option('--target-home <directory>', 'Alternative user configuration root')
  .action(async (client, opts) => {
    const registration = setup(client, home(), opts);
    const config = loadConfig(home());
    if (opts.allowPath) {
      config.allowedPaths = [...new Set([...config.allowedPaths, ...opts.allowPath.map((p: string) => resolve(p))])];
    }
    let model = 'ready';
    if (!opts.dryRun) {
      saveConfig(home(), config);
      console.error('Preparing the local embedding model (about 23 MB, downloaded once)...');
      const embedder = new LocalEmbedder(home());
      try {
        await embedder.embed(['memlio']);
      } catch (e) {
        model = `${errorText(e)} Keyword search works now; semantic search starts once the model downloads on first use.`;
      } finally {
        await embedder.dispose();
      }
    }
    emit({ ...registration, allowedPaths: config.allowedPaths, model }, (r) =>
      [
        `${r.dryRun ? 'Would register' : 'Registered'} the memlio MCP server in ${r.configPath}`,
        `${r.dryRun ? 'Would install' : 'Installed'} the skill at ${r.skillPath}`,
        r.allowedPaths.length ? `Agent may save files from: ${r.allowedPaths.join(', ')}` : '',
        `Embedding model: ${r.model}`,
        r.dryRun ? '' : `Restart ${client} to load the server. Then try: /memlio store <url or note>`,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  });

program
  .command('store')
  .description('Save a note, URL, or file')
  .argument('[input...]', 'Text, URL, or local file path')
  .option('--stdin', 'Read a note from standard input')
  .option('--clipboard', 'Save the image on the system clipboard')
  .addOption(new Option('--kind <kind>').choices(['note', 'url', 'file']))
  .option('--title <title>')
  .option('--note <context>', 'Why you saved it')
  .option('--description <text>', 'A description of an image or asset')
  .action(async (parts, opts) => {
    let input = parts.join(' ');
    if (opts.clipboard && (input || opts.stdin)) throw new Error('Use --clipboard on its own, without an argument or --stdin.');
    if (opts.stdin) {
      if (input) throw new Error('Use an argument or --stdin, not both.');
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of process.stdin) {
        bytes += chunk.length;
        if (bytes > 1_000_000) throw new Error('Stdin exceeds 1 MB.');
        chunks.push(Buffer.from(chunk));
      }
      input = Buffer.concat(chunks).toString('utf8');
    }
    await withMemory(
      async (m) =>
        summarize(await m.store({ input, ...opts, kind: opts.kind ?? (opts.stdin ? 'note' : undefined) }, { explicit: true })),
      formatSaved,
    );
  });

program
  .command('find')
  .alias('retrieve')
  .description('Find saved items from a description')
  .argument('<query...>')
  .addOption(new Option('--kind <kind>').choices(['note', 'url', 'file']))
  .option('--limit <count>', 'Maximum results', '5')
  .option('--after <date>', 'Saved on or after YYYY-MM-DD')
  .option('--before <date>', 'Saved on or before YYYY-MM-DD')
  .action(async (parts, opts) =>
    withMemory(
      (m) => m.search(parts.join(' '), { ...opts, limit: Number(opts.limit) }),
      (r) => {
        for (const warning of r.warnings) console.error(`Warning: ${warning}`);
        if (!r.results.length) return `No matches (${r.mode}).`;
        return r.results.map((x) => `${x.id}  ${x.title}\n${x.reason}\n${x.url ?? x.assetPath ?? ''}\n${x.excerpt}`).join('\n\n');
      },
    ),
  );

program
  .command('get')
  .description('Print one saved record as JSON')
  .argument('<id>')
  .action(async (id) =>
    withMemory(
      (m) => m.get(id),
      (v) => JSON.stringify(v, null, 2),
    ),
  );

program
  .command('status')
  .description('Show collection health')
  .action(async () => withMemory((m) => m.status(), formatStatus));

program
  .command('repair')
  .description('Rebuild search data, retry failed page captures, and embed anything missing')
  .action(async () => withMemory((m) => m.repair(), formatStatus));

program
  .command('delete')
  .description('Permanently delete one item')
  .argument('<id>')
  .requiredOption('--yes', 'Confirm permanent deletion')
  .action(async (id) =>
    withMemory(
      (m) => m.delete(id),
      (r) => `Deleted ${r.deleted}${r.cleanupError ? ` (asset cleanup failed: ${r.cleanupError})` : ''}`,
    ),
  );

program
  .command('export')
  .description('Copy records and original files to a new directory')
  .argument('<directory>')
  .action(async (target) =>
    withMemory(
      (m) => m.export(target),
      (r) => `Exported ${r.count} items to ${r.destination}`,
    ),
  );

program
  .command('import')
  .description('Restore records and files from a memlio export')
  .argument('<directory>')
  .action(async (source) =>
    withMemory(
      (m) => m.import(source),
      (r) => `Imported ${r.imported} items (${r.duplicates} already present)\n${formatStatus(r)}`,
    ),
  );

program
  .command('mcp', { hidden: true })
  .description('Run the MCP server over stdio')
  .action(async () => serve(home()));

program.parseAsync().catch((error) => {
  console.error(`memlio: ${errorText(error)}`);
  process.exitCode = 1;
});
