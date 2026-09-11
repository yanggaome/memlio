import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { Memory } from '../dist/store.js';
import { saveConfig, loadConfig } from '../dist/config.js';
import { extractPage, isPublicAddress, publicTarget } from '../dist/capture.js';
const exec=promisify(execFile);
const cli=resolve('dist/cli.js');
function fixture(t){const root=realpathSync(mkdtempSync(join(tmpdir(),'memlio-test-')));t.after(()=>rmSync(root,{recursive:true,force:true}));return root;}
// Persistence/capture tests explicitly opt out of model loading.
function keywordMemory(home){saveConfig(home,{version:1,semantic:false,allowedPaths:[]});return new Memory(home);}
async function run(home,...args){if(!existsSync(join(home,'config.json')))saveConfig(home,{version:1,semantic:false,allowedPaths:[]});const {stdout}=await exec(process.execPath,[cli,'--home',home,'--json',...args]);return JSON.parse(stdout);}

test('fresh collections embed saves and use hybrid retrieval without initialization',async t=>{
  const home=fixture(t),calls=[];
  const memory=new Memory(home,{name:'test-model',embed:async texts=>{calls.push(...texts);return texts.map(()=>[1,0]);},dispose:async()=>{}});
  t.after(()=>memory.close());
  const saved=await memory.store({input:'Use a password manager'});
  assert.equal(saved.item.indexing,'ready');
  const result=await memory.search('protect online accounts');
  assert.equal(result.mode,'hybrid');assert.equal(result.results[0].id,saved.item.id);
  assert.equal(result.results[0].keyword,false);assert.equal(calls.length,2);
});

test('keyword-only initialization stays offline and preserves its explicit preference',async t=>{
  const root=fixture(t),home=join(root,'collection');
  const options={env:{...process.env,MEMLIO_OFFLINE:'1',MEMLIO_MODEL_CACHE:join(root,'empty-model-cache')}};
  const invoke=(...args)=>exec(process.execPath,[cli,'--home',home,'--json',...args],options);
  assert.equal(JSON.parse((await invoke('init','--keyword-only')).stdout).semantic,false);
  assert.equal(JSON.parse((await invoke('init')).stdout).semantic,false);
  await invoke('init','--allow-path',root);
  assert.deepEqual(loadConfig(home),{version:1,semantic:false,allowedPaths:[root]});
  const saved=JSON.parse((await invoke('store','Remember the offline garden')).stdout);
  assert.equal(saved.indexing,'disabled');
  assert.equal(JSON.parse((await invoke('retrieve','garden')).stdout).mode,'keyword');
  await assert.rejects(invoke('init','--semantic','--keyword-only'),/Choose --semantic or --keyword-only/);
  await assert.rejects(invoke('init','--semantic')); // Missing model cannot silently replace the explicit preference.
  assert.equal(loadConfig(home).semantic,false);
});

test('CLI storage persists across processes and unrelated working directories',async t=>{
  const root=fixture(t),home=join(root,'collection');
  const saved=await run(home,'store','An orchard of rare apples','--note','For my garden');
  const {stdout}=await exec(process.execPath,[cli,'--home',home,'--json','retrieve','garden'],{cwd:tmpdir()});
  assert.equal(JSON.parse(stdout).results[0].id,saved.id);
  const item=await run(home,'get',saved.id);assert.equal(item.original,'An orchard of rare apples');
});
test('concurrent first-start writers retain all notes',async t=>{
  const home=join(fixture(t),'collection');
  await Promise.all(Array.from({length:8},(_,i)=>run(home,'store',`Independent writer ${i} unique record`)));
  assert.equal((await run(home,'status')).count,8);
});
test('concurrent duplicate saves create one item',async t=>{
  const home=join(fixture(t),'collection');
  const saves=await Promise.all(Array.from({length:5},()=>run(home,'store','Identical thought')));
  assert.equal(new Set(saves.map(s=>s.id)).size,1);assert.equal((await run(home,'status')).count,1);
});
test('file originals survive source deletion; MCP access is restricted',async t=>{
  const root=fixture(t),path=join(root,'picture.png');writeFileSync(path,Buffer.from([137,80,78,71,1,2,3]));
  const memory=keywordMemory(join(root,'collection'));t.after(()=>memory.close());
  await assert.rejects(memory.store({input:path}),/outside allowed/);
  const saved=await memory.store({input:path,description:'Dark dashboard with orange charts'},{roots:[root]});
  const original=readFileSync(path);rmSync(path);
  assert.deepEqual(readFileSync(join(memory.home,'assets',saved.item.asset)),original);
  assert.equal((await memory.search('orange charts')).results[0].id,saved.item.id);
});
test('failed URL capture preserves bookmark, context and error',async t=>{
  const memory=keywordMemory(fixture(t));t.after(()=>memory.close());
  const {item}=await memory.store({input:'http://127.0.0.1/private',note:'Design archive'});
  assert.equal(item.capture,'failed');assert.match(item.captureError,/blocked/);
  assert.equal(item.original,'http://127.0.0.1/private');assert.equal((await memory.search('design archive')).results[0].id,item.id);
});
test('pending URL remains visible and has explicit pending capture state',async t=>{
  const memory=keywordMemory(fixture(t));t.after(()=>memory.close());
  const {item}=await memory.store({input:'https://example.com/article',defer:true,note:'Lentil recipe'});
  assert.equal(item.capture,'pending');assert.equal(memory.status().capturePending,1);
  assert.equal((await memory.search('lentil')).results[0].id,item.id);
});
test('literal URL-shaped notes do not fetch',async t=>{
  const memory=keywordMemory(fixture(t));t.after(()=>memory.close());
  const {item}=await memory.store({input:'http://127.0.0.1/',kind:'note'});
  assert.equal(item.kind,'note');assert.equal(item.capture,'ready');
});
test('readable snapshot extracts content and excludes scripts',()=>{
  const article='This article describes durable execution, retries, and background task recovery. '.repeat(30);
  const result=extractPage(`<html><head><title>Reliable tasks</title></head><body><nav>Menu</nav><article><h1>Reliable tasks</h1><p>${article}</p></article><script>secretExecutable()</script></body></html>`,'https://example.com');
  assert.equal(result.title,'Reliable tasks');assert.match(result.markdown,/durable execution/);assert.doesNotMatch(result.markdown,/secretExecutable/);
});
test('public destination policy rejects private and alternate IP representations',async()=>{
  for(const ip of ['127.0.0.1','10.0.0.1','192.168.1.3','172.16.0.2','169.254.169.254','::1','::ffff:127.0.0.1','fc00::1','fe80::1','0.0.0.0','224.0.0.1'])assert.equal(isPublicAddress(ip),false,ip);
  assert.equal(isPublicAddress('1.1.1.1'),true);
  await assert.rejects(publicTarget('http://2130706433/'),/blocked/);
  await assert.rejects(publicTarget('https://user:pass@example.com'),/credentials/);
  await assert.rejects(publicTarget('file:///etc/passwd'),/HTTP/);
});
test('index rebuild recovers keyword index and deletion removes search hits',async t=>{
  const memory=keywordMemory(fixture(t));t.after(()=>memory.close());
  const {item}=await memory.store({input:'A telescope for observing Saturn'});
  memory.db.exec('DELETE FROM search');assert.equal((await memory.search('telescope')).results.length,0);
  await memory.reindex();assert.equal((await memory.search('telescope')).results[0].id,item.id);
  memory.delete(item.id);assert.equal((await memory.search('telescope')).results.length,0);assert.throws(()=>memory.get(item.id),/not found/);
});
test('deleting one reference preserves a shared asset',async t=>{
  const root=fixture(t),path=join(root,'photo.png');writeFileSync(path,'image bytes');
  const memory=keywordMemory(join(root,'collection'));t.after(()=>memory.close());
  const a=await memory.store({input:path,note:'first'},{explicit:true});const b=await memory.store({input:path,note:'second'},{explicit:true});
  const asset=join(memory.home,'assets',a.item.asset);
  memory.delete(a.item.id);assert.ok(existsSync(asset));memory.delete(b.item.id);assert.equal(existsSync(asset),false);
});
test('export and import preserve IDs, original bytes and searchability',async t=>{
  const root=fixture(t),path=join(root,'sketch.png');writeFileSync(path,'sketch bytes');
  const first=keywordMemory(join(root,'first')),second=keywordMemory(join(root,'second'));t.after(async()=>{await first.close();await second.close();});
  const saved=await first.store({input:path,description:'Blue kitchen shelves'},{explicit:true});
  first.export(join(root,'backup'));second.import(join(root,'backup'));
  assert.equal(second.get(saved.item.id).description,'Blue kitchen shelves');
  assert.equal(readFileSync(join(second.home,'assets',saved.item.asset),'utf8'),'sketch bytes');
  assert.equal((await second.search('kitchen')).results[0].id,saved.item.id);
  assert.equal(second.import(join(root,'backup')).duplicates,1);
});
test('import rejects asset path traversal before changing catalog',async t=>{
  const root=fixture(t),memory=keywordMemory(join(root,'first'));t.after(()=>memory.close());
  const saved=await memory.store({input:'hello'});memory.export(join(root,'backup'));
  const file=join(root,'backup','records.json'),manifest=JSON.parse(readFileSync(file,'utf8'));manifest.items[0].asset='../secret';writeFileSync(file,JSON.stringify(manifest));
  assert.throws(()=>memory.import(join(root,'backup')));assert.equal(memory.status().count,1);
});
test('embedding failure does not lose a saved note',async t=>{
  const home=fixture(t);saveConfig(home,{version:1,semantic:true,allowedPaths:[]});
  const memory=new Memory(home,{name:'failing',embed:async()=>{throw new Error('provider offline');},dispose:async()=>{}});t.after(()=>memory.close());
  const saved=await memory.store({input:'Preserve this even offline'});
  assert.equal(saved.item.indexing,'failed');assert.equal(saved.item.indexError,'provider offline');
  assert.equal((await memory.search('preserve',{mode:'keyword'})).results[0].id,saved.item.id);
  assert.equal((await memory.search('anything',{mode:'semantic'})).warnings.length,1);
});
test('semantic mode is explicit when disabled; empty unrelated keyword search has no hits',async t=>{
  const memory=keywordMemory(fixture(t));t.after(()=>memory.close());await memory.store({input:'Grow tomatoes'});
  await assert.rejects(memory.search('plants',{mode:'semantic'}),/disabled/);
  assert.equal((await memory.search('interplanetary spaceships')).results.length,0);
  await assert.rejects(memory.search('plants',{limit:-1}),/Limit/);
});
test('type and date filters scope retrieval',async t=>{
  const memory=keywordMemory(fixture(t));t.after(()=>memory.close());await memory.store({input:'coffee beans'});await memory.store({input:'https://example.com/coffee',note:'coffee',defer:true});
  assert.equal((await memory.search('coffee',{kind:'url'})).results.length,1);
  assert.equal((await memory.search('coffee',{before:'2000-01-01'})).results.length,0);
});
