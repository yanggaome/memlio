#!/usr/bin/env node
import { Command, Option } from 'commander';
import { resolve } from 'node:path';
import { dataHome, loadConfig, saveConfig } from './config.js';
import { Memory, type Kind } from './store.js';
import { LocalEmbedder } from './embedding.js';
import { setup } from './setup.js';
import { serve } from './mcp.js';

const program = new Command().name('mem').version('0.1.0').description('Save something now. Find it later from a vague description.')
  .option('--home <directory>','Collection directory (also MEM_HOME)')
  .option('--json','Machine-readable JSON output');
const home=()=>dataHome(program.opts().home);
function output(value:any) {
  if (program.opts().json) {console.log(JSON.stringify(value,null,2));return;}
  if (value.results) {
    console.log(`${value.results.length} matches (${value.mode})`);
    for (const warning of value.warnings) console.error(`Warning: ${warning}`);
    for (const r of value.results) console.log(`\n${r.id}  ${r.title}\n${r.reason}\n${r.url??r.assetPath??''}\n${r.excerpt}`);
  } else console.log(JSON.stringify(value,null,2));
}
async function withMemory<T>(fn:(memory:Memory)=>Promise<T>|T) {const memory=new Memory(home());try{output(await fn(memory));}finally{await memory.close();}}
program.command('init').description('Initialize storage; optionally download and enable the local embedding model')
  .option('--semantic','Download/cache the local semantic model and enable it')
  .option('--keyword-only','Disable semantic search')
  .option('--allow-path <directory...>','Allow MCP capture from these directories')
  .action(async opts=>{
    const config=loadConfig(home());
    if(opts.semantic && opts.keywordOnly) throw new Error('Choose --semantic or --keyword-only.');
    if(opts.semantic) {
      console.error('Preparing local embeddings (first run downloads model files from Hugging Face).');
      const embedder=new LocalEmbedder(home());
      try {await embedder.embed(['Initialize personal memory']);config.semantic=true;}finally{await embedder.dispose();}
    }
    if(opts.keywordOnly) config.semantic=false;
    if(opts.allowPath) config.allowedPaths=[...new Set([...config.allowedPaths,...opts.allowPath.map((p:string)=>resolve(p))])];
    saveConfig(home(),config);
    await withMemory(m=>({...m.status(),next:config.semantic?'Run mem reindex to index any previously saved items.':'Use mem init --semantic to enable natural-language similarity search.'}));
  });
program.command('store').description('Preserve a note, URL, or file and index its content')
  .argument('[input...]','Text, URL, or local file path')
  .option('--stdin','Read a note from standard input')
  .addOption(new Option('--kind <kind>').choices(['note','url','file']))
  .option('--title <title>').option('--note <context>','Why you saved it').option('--description <text>','A description of an image or asset')
  .option('--defer','Save now; run mem retry later to capture/index')
  .action(async (parts,opts)=>{
    let input=parts.join(' ');
    if(opts.stdin){if(input)throw new Error('Use an argument or --stdin, not both.');const chunks:Buffer[]=[];let bytes=0;for await(const chunk of process.stdin){bytes+=chunk.length;if(bytes>1_000_000)throw new Error('Stdin exceeds 1 MB.');chunks.push(Buffer.from(chunk));}input=Buffer.concat(chunks).toString('utf8');}
    await withMemory(async m=>{const saved=await m.store({input,...opts,kind:opts.kind??(opts.stdin?'note':undefined)},{explicit:true});return {id:saved.item.id,title:saved.item.title,duplicate:saved.duplicate,capture:saved.item.capture,captureError:saved.item.captureError,indexing:saved.item.indexing,indexError:saved.item.indexError};});
  });
program.command('retrieve').alias('search').description('Search your collection')
  .argument('<query...>')
  .addOption(new Option('--mode <mode>').choices(['keyword','semantic','hybrid']))
  .addOption(new Option('--kind <kind>').choices(['note','url','file']))
  .option('--limit <count>','Maximum results','5').option('--after <date>').option('--before <date>')
  .action(async(parts,opts)=>withMemory(m=>m.search(parts.join(' '),{...opts,limit:Number(opts.limit)})));
program.command('get').argument('<id>').description('Read an original saved record').action(async id=>withMemory(m=>m.get(id)));
program.command('status').description('Show collection health').action(async()=>withMemory(m=>m.status()));
program.command('retry').description('Retry pending/failed capture and embedding work').action(async()=>withMemory(m=>m.retry()));
program.command('reindex').description('Rebuild search data from stored records').action(async()=>withMemory(m=>m.reindex()));
program.command('delete').argument('<id>').requiredOption('--yes','Confirm permanent deletion').action(async id=>withMemory(m=>m.delete(id)));
program.command('export').argument('<directory>').description('Export portable records and original assets to a new directory').action(async target=>withMemory(m=>m.export(target)));
program.command('import').argument('<directory>').description('Restore records and assets from a mem export').action(async source=>withMemory(m=>m.import(source)));
program.command('setup').argument('<client>','codex or claude').option('--dry-run','Preview paths and registration without changes').option('--target-home <directory>','Alternative user configuration root').action((client,opts)=>output(setup(client,home(),opts)));
program.command('mcp').description('Run the MCP server over stdio').action(async()=>serve(home()));
program.command('doctor').description('Check runtime and collection configuration').action(async()=>withMemory(m=>({node:process.version,executable:process.execPath,...m.status()})));
program.parseAsync().catch(error=>{console.error(`mem: ${error instanceof Error?error.message:String(error)}`);process.exitCode=1;});
