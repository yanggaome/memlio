// Reproducible synthetic smoke benchmark, not a claim about real personal collections.
import { mkdtempSync,rmSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir,platform,arch } from 'node:os';
import { performance } from 'node:perf_hooks';
import { Memory } from '../dist/store.js';
import { saveConfig } from '../dist/config.js';

const cases=[
  ['Durable execution','A worker may crash halfway through a task. Persist queue state and retry unfinished work with idempotency keys.','the article about making background jobs reliable'],
  ['Espresso dialing','Adjust grind size and extraction time to balance sourness and bitterness in espresso.','how to make better coffee'],
  ['Emergency fund','Keep three to six months of living expenses in accessible savings for unexpected unemployment.','money buffer if I lose my job'],
  ['Tiny apartment','Foldaway furniture and vertical shelving make a studio apartment more usable.','space saving furniture for a small home'],
  ['Bicycle maintenance','Degrease and lubricate the chain regularly to reduce friction and prevent premature drivetrain wear.','fix my squeaky bike'],
  ['Bread fermentation','An overnight refrigerator proof develops sourdough flavor and makes the dough easier to score.','that baking tip about resting dough in the fridge'],
  ['Jet lag','Shift your bedtime before travel and seek morning sunlight after an eastbound flight.','adjust my body clock after flying overseas'],
  ['Photo backups','Use three copies of important images across two media types with one copy stored offsite.','protect family pictures if my hard drive dies'],
  ['Screen fatigue','Look at a distant object every twenty minutes and adjust monitor brightness to reduce eye strain.','my eyes hurt after working at a computer'],
  ['Houseplant care','Yellow leaves often indicate overwatering. Let the top layer of soil dry before watering again.','why is my indoor plant turning yellow'],
  ['Conference networking','Write a short note about each person you meet and follow up with a specific shared interest.','remember people I met at an event'],
  ['Password hygiene','Use a password manager to generate unique credentials and enable two-factor authentication.','secure my online accounts'],
  ['Distributed transactions','The outbox pattern writes business changes and events in the same transaction, then publishes asynchronously.','avoid losing messages when the database update succeeds'],
  ['Accessible forms','Associate visible labels with each input and explain validation errors beside the affected field.','make signup forms easier for screen reader users'],
  ['Rainy hiking','Pack a waterproof shell, dry socks, and a sealed bag for electronics when the forecast is wet.','what should I bring for a walk in the mountains during a storm'],
  ['Budget meals','Lentils, chickpeas and dried beans provide inexpensive protein and work well in batch-cooked stews.','cheap vegetarian dinners with lots of protein'],
  ['Interview preparation','Practice describing a difficult project using situation, task, action and result, with concrete outcomes.','tell a good story in a job interview'],
  ['Apartment acoustics','Rugs, heavy curtains and soft furnishings absorb reflections and reduce echo in empty rooms.','make my living room less noisy and echoey'],
  ['Git recovery','The reflog records recent reference changes and can help recover a branch after an accidental reset.','get back commits I accidentally removed'],
  ['API rate limits','Exponential backoff with jitter spreads retries over time and prevents a thundering herd.','stop clients overwhelming a service when retrying'],
  ['Garden compost','Combine nitrogen-rich kitchen scraps with carbon-rich dry leaves, keeping the pile damp and aerated.','turn food waste into fertilizer'],
  ['Sleep routine','A consistent wake time, cool bedroom and less evening caffeine support better sleep.','habits to help me fall asleep'],
  ['Presentation pacing','Use a clear story, sparse slides and a pause after each key point so the audience can follow.','how to give a talk without rushing'],
  ['Travel adapter','Japan commonly uses type A electrical outlets. Check charger voltage compatibility before packing.','the plug I need for my Tokyo trip'],
  ['Database performance','Use EXPLAIN to inspect query plans and add indexes for frequently filtered columns.','speed up slow SQL queries'],
  ['Design reference','Image description: a dark analytics dashboard with orange charts, a left sidebar and compact metric cards.','the dark dashboard with orange charts'],
  ['Restaurant menu','Image description: a handwritten cafe menu featuring mushroom toast and lavender lemonade.','picture of that cafe selling purple drinks'],
  ['Reading nook','Image description: a green armchair beside a tall lamp and a wall of oak bookshelves.','that cozy chair surrounded by books'],
  ['Workshop whiteboard','Image description: arrows connect a browser, an API gateway, a job queue and several background workers.','photo of the architecture drawing with a queue'],
  ['Kitchen inspiration','Image description: blue open shelves above a white tiled backsplash, with brass hooks for mugs.','the kitchen with blue shelving'],
];
const home=mkdtempSync(join(tmpdir(),'memlio-eval-'));
saveConfig(home,{version:1,semantic:true,allowedPaths:[]});
const memory=new Memory(home),expected=[];
const started=performance.now();
try {
  for(const [title,text,query] of cases){const saved=await memory.store({input:text,title,source:'synthetic-evaluation',defer:true});expected.push({id:saved.item.id,query});}
  for(let i=0;i<70;i++)await memory.store({input:`Inventory reference ${i}: shelf ${i+100}, carton ${i+200}, batch number ${i+300}. Routine warehouse receipt for miscellaneous packing supplies.`,title:`Warehouse receipt ${i}`,defer:true});
  await memory.retry();
  if(memory.status().indexFailed)throw new Error(`${memory.status().indexFailed} indexing failures: ${memory.status().failures[0]?.indexError}`);
  const indexingMs=performance.now()-started;
  const report={corpus:'100 synthetic text records (30 targets, 70 warehouse distractors); five targets describe images in text. No agent rewriting.',node:process.version,platform:platform(),arch:arch(),model:memory.embedder.name,indexingMs,peakRssBytes:0,modes:{}};
  for(const mode of ['keyword','semantic','hybrid']){
    const times=[],misses=[];let top1=0,top5=0;
    for(const {id,query} of expected){const start=performance.now(),result=await memory.search(query,{mode,limit:5});times.push(performance.now()-start);if(result.results[0]?.id===id)top1++;if(result.results.some(r=>r.id===id))top5++;else misses.push(query);}
    times.sort((a,b)=>a-b);
    report.modes[mode]={queries:expected.length,top1,top5,recallAt5:top5/expected.length,medianMs:times[Math.floor(times.length/2)],p95Ms:times[Math.floor(times.length*.95)],misses};
  }
  report.peakRssBytes=process.resourceUsage().maxRSS*1024;
  const absent=[];
  for(const query of ['the invoice number from my dentist last Tuesday','the exact serial number of my lost passport','the name of my second grade teacher']){
    const result=await memory.search(query,{mode:'hybrid'});absent.push({query,candidates:result.results.length,topSimilarity:result.results[0]?.similarity??null});
  }
  report.noMatchProbes=absent;
  const json=JSON.stringify(report,null,2);console.log(json);
  if(process.env.MEMLIO_EVAL_OUTPUT)writeFileSync(process.env.MEMLIO_EVAL_OUTPUT,json+'\n');
}finally{await memory.close();rmSync(home,{recursive:true,force:true});}
