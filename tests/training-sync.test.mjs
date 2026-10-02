import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { build } from 'esbuild';

const built = await build({entryPoints:['src/TrainingLabSync.ts'],bundle:true,platform:'node',format:'cjs',write:false});
const module = {exports:{}};
vm.runInNewContext(built.outputFiles[0].text,{module,exports:module.exports,TextEncoder});
// Load the same repository implementation via a second bundle.
const repoBuild = await build({entryPoints:['src/TrainingLab.ts'],bundle:true,platform:'node',format:'cjs',write:false});
const repoModule = {exports:{}};
vm.runInNewContext(repoBuild.outputFiles[0].text,{module:repoModule,exports:repoModule.exports,TextEncoder});
const {TrainingLabSync,TRAINING_QUEUE:Q} = module.exports;
let history = null, writes = 0, failHistory = false;
const repo = new repoModule.exports.TrainingLabRepository({read:async()=>history,write:async s=>{
  if(failHistory) throw new Error('test history write failure');
  history=s; writes++;
}});
const files = new Map();
let failReply = false;
const adapter = {
  exists:async p=>p===Q ? files.size>0 : files.has(p),
  list:async()=>({files:[...files.keys()],folders:[]}),
  stat:async p=>files.has(p)?{size:new TextEncoder().encode(files.get(p)).length}:null,
  read:async p=>files.get(p),
  write:async(p,s)=>{if(failReply)throw new Error('reply write failure'); files.set(p,s);},
  rename:async(a,b)=>{files.set(b,files.get(a));files.delete(a);}
};
const sync = new TrainingLabSync(adapter,repo);
const fixture = JSON.parse(await readFile('examples/training-lab/round-01.instrument.json','utf8'));
fixture.kind='training';fixture.config.mode='brain_objects';fixture.runId='sync-test';
fixture.candidates[0].teacher={model:'fixture-only',decision:'approve',rationale:'Unit fixture, not an AI inference.'};
fixture.candidates.push({...structuredClone(fixture.candidates[0]),id:'wrong',definition:{op:'const',value:'7'}});
fixture.candidates.push({...structuredClone(fixture.candidates[0]),id:'uncertain',teacher:{model:'fixture-only',decision:'uncertain',rationale:'Unit fixture.'}});
function request(id,round,operation='import') {
  const value={schemaVersion:1,kind:'lain-brain-training-request',requestId:id,operation};
  if(round)value.roundJson=JSON.stringify(round);
  files.set(`${Q}/request-${id}.json`,JSON.stringify(value));
}
const reply=id=>JSON.parse(files.get(`${Q}/response-${id}.json`));
await sync.tick(); assert.equal(history,null);
request('probe',null,'probe'); await sync.tick(); assert.equal(reply('probe').protocol,'training-sync-v1');assert.equal(history,null);
request('r1',fixture); await Promise.all([sync.tick(),sync.tick()]);
assert.equal(writes,1);assert.equal(reply('r1').status,'ok');assert.equal(reply('r1').library.objects.length,1);
assert.deepEqual(reply('r1').verifications.map(v=>v.acceptance),['accepted','rejected','awaiting_teacher']);
assert.equal(reply('r1').library.objects[0].reference.split,'train');
await sync.tick(); assert.equal(writes,1,'Completed requests do not reimport');
request('r1-retry',fixture);await sync.tick();assert.equal(reply('r1-retry').status,'ok');assert.equal(writes,1);
const changed=structuredClone(fixture);changed.student.checkpointSha256='9'.repeat(64);
request('collision',changed);await sync.tick();assert.equal(reply('collision').status,'error');assert.equal(writes,1);
const r2=structuredClone(fixture);r2.round=2;r2.measurements.steps=2;r2.candidates=[];
request('r2',r2);await sync.tick();assert.equal(reply('r2').library.throughRound,2);assert.equal(writes,2);
request('old-boundary',fixture);await sync.tick();assert.equal(reply('old-boundary').library.throughRound,1);
const instrument=structuredClone(fixture);instrument.kind='instrument';instrument.runId='fixture';
request('instrument',instrument);await sync.tick();assert.equal(reply('instrument').status,'error');assert.equal(writes,2);
request('path-mismatch',fixture);const p=`${Q}/request-path-mismatch.json`;files.set(p,files.get(p).replace('"requestId":"path-mismatch"','"requestId":"other"'));
await sync.tick();assert.equal(reply('path-mismatch').status,'error');
const r3=structuredClone(r2);r3.round=3;r3.measurements.steps=3;
failHistory=true;request('write-failure',r3);await sync.tick();assert.equal(reply('write-failure').status,'error');assert.equal(writes,2);
failHistory=false;failReply=true;request('reply-failure',r3);
await assert.rejects(sync.tick(),/reply write failure/);assert.equal(writes,3);
failReply=false;await sync.tick();assert.equal(reply('reply-failure').status,'ok');assert.equal(writes,3,'Saved history is recovered after reply failure');
assert(![...files.keys()].some(p=>p.endsWith('.pending')));
console.log('PASS: opt-in probe, automatic import/export, exact gate stronger than teacher, idempotence, boundary, identity, write/reply recovery');
