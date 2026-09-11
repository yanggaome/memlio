import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import TOML from '@iarna/toml';
import { setup } from '../dist/setup.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Memory } from '../dist/store.js';
function fixture(t){const root=mkdtempSync(join(tmpdir(),'mem-integration-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return root;}
test('Codex setup preserves existing settings/comments and is idempotent',t=>{
  const root=fixture(t);mkdirSync(join(root,'.codex'));writeFileSync(join(root,'.codex','config.toml'),'# keep me\nmodel = "custom"\n[mcp_servers.other]\ncommand = "other"\n');
  setup('codex',join(root,'collection'),{targetHome:root});setup('codex',join(root,'collection'),{targetHome:root});
  const text=readFileSync(join(root,'.codex','config.toml'),'utf8'),parsed=TOML.parse(text);
  assert.match(text,/# keep me/);assert.equal(parsed.model,'custom');assert.equal(parsed.mcp_servers.other.command,'other');assert.equal(parsed.mcp_servers.mem.command,process.execPath);
  assert.equal(text.split('[mcp_servers.mem]').length,2);
});
test('Claude setup merges settings and dry-run leaves files unchanged',t=>{
  const root=fixture(t);writeFileSync(join(root,'.claude.json'),JSON.stringify({theme:'dark',mcpServers:{other:{command:'other'}}}));
  setup('claude',join(root,'collection'),{targetHome:root,dryRun:true});assert.equal(JSON.parse(readFileSync(join(root,'.claude.json'),'utf8')).mcpServers.mem,undefined);
  setup('claude',join(root,'collection'),{targetHome:root});const parsed=JSON.parse(readFileSync(join(root,'.claude.json'),'utf8'));
  assert.equal(parsed.theme,'dark');assert.equal(parsed.mcpServers.other.command,'other');assert.equal(parsed.mcpServers.mem.type,'stdio');
});
test('setup refuses to replace an unrelated existing mem server',t=>{
  const root=fixture(t);writeFileSync(join(root,'.claude.json'),JSON.stringify({mcpServers:{mem:{command:'someone-else'}}}));
  assert.throws(()=>setup('claude',root,{targetHome:root}),/existing/);
});
test('real MCP SDK client stores, searches and reads across fresh servers',async t=>{
  const root=fixture(t),home=join(root,'collection');
  async function connect(){const client=new Client({name:'mem-test',version:'1.0'});await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve('dist/cli.js'),'--home',home,'mcp'],stderr:'pipe'}));return client;}
  const first=await connect();let id;
  try {
    const tools=await first.listTools();assert.ok(tools.tools.some(t=>t.name==='mem_store'));
    const response=await first.callTool({name:'mem_store',arguments:{input:'A travel adapter for Japan',note:'Packing list'}});assert.ok(!response.isError);id=JSON.parse(response.content[0].text).id;
  }finally{await first.close();}
  const second=await connect();
  try {
    const response=await second.callTool({name:'mem_search',arguments:{query:'packing'}});assert.equal(JSON.parse(response.content[0].text).results[0].id,id);
    const read=await second.callTool({name:'mem_get',arguments:{id,maxChars:10}});assert.equal(JSON.parse(read.content[0].text).text.length,10);assert.equal(JSON.parse(read.content[0].text).nextOffset,10);
    const bad=await second.callTool({name:'mem_store',arguments:{input:'/etc/hosts',kind:'file'}});assert.equal(bad.isError,true);
  }finally{await second.close();}
  const memory=new Memory(home);assert.equal(memory.status().count,1);await memory.close();
});
