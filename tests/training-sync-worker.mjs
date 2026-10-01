// Test-only filesystem host for the actual Brain service, not shipped to users.
import {readFile,writeFile,readdir,stat,rename,mkdir,rm,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const vault=process.argv[2];if(!vault)throw new Error('Supply test vault');
const temp=await mkdtemp(path.join(tmpdir(),'brain-sync-worker-'));
const bundle=path.join(temp,'sync.mjs');
await build({stdin:{contents:'export * from "./src/TrainingLabSync"; export * from "./src/TrainingLab";',resolveDir:process.cwd(),loader:'ts'},bundle:true,format:'esm',platform:'node',outfile:bundle});
const api=await import(pathToFileURL(bundle).href);
const exists=async p=>{try{await stat(p);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
const absolute=p=>path.join(vault,p);
const history=absolute('.obsidian/plugins/lain-brain/training-lab.json');
await mkdir(path.dirname(history),{recursive:true});
const repo=new api.TrainingLabRepository({read:async()=>await exists(history)?readFile(history,'utf8'):null,write:async s=>writeFile(history,s)});
const service=new api.TrainingLabSync({
  exists:p=>exists(absolute(p)),
  list:async p=>({files:(await readdir(absolute(p),{withFileTypes:true})).filter(d=>d.isFile()).map(d=>`${p}/${d.name}`),folders:[]}),
  stat:p=>stat(absolute(p)),read:p=>readFile(absolute(p),'utf8'),write:(p,s)=>writeFile(absolute(p),s),rename:(a,b)=>rename(absolute(a),absolute(b))
},repo);
const timer=setInterval(()=>service.tick().catch(e=>{console.error(e);process.exitCode=1;}),25);
console.log('READY');
process.on('SIGTERM',async()=>{clearInterval(timer);await rm(temp,{recursive:true,force:true});process.exit(0);});
