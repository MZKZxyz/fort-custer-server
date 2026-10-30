import { randomBytes } from 'node:crypto';
import { mkdirSync, openSync, writeFileSync, closeSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve, dirname, join } from 'node:path';
import { generate, algorithmVersion } from '../../lib/maze/stamp-v2.js';

// Disposable research only. The raw sample is outside Git, mode 0700/0600.
const root = process.argv[2], count = Number(process.argv[3] ?? 30);
const repo = realpathSync(new URL('../..', import.meta.url).pathname);
const destination = root && isAbsolute(root) ? join(realpathSync(dirname(root)), root.split('/').at(-1)) : '';
if (!root || !isAbsolute(root) || destination === repo || destination.startsWith(repo + '/')
    || !Number.isInteger(count) || count < 1 || count > 1000) throw new Error('PRIVATE_ROOT_AND_COUNT_REQUIRED');
mkdirSync(destination, { mode: 0o700, recursive: false });
const file = openSync(`${destination}/sample.jsonl`, 'wx', 0o600);
const rows = [], failures = {};
try {
  for (const tier of ['easy', 'medium', 'hard']) for (const [width,height] of [[13,17],[17,19],[21,21]]) for(let i=0;i<count;i++) {
    const seed = randomBytes(32).toString('hex');
    try {
      const x = generate({seed,tier,config:{width,height}});
      const row = {tier,width,height,seed,acceptedAttempt:x.acceptedAttempt,grid:x.grid,metrics:x.metrics};
      writeFileSync(file,JSON.stringify(row)+'\n'); rows.push(row);
    } catch(e) { failures[`${tier}/${width}x${height}`]=(failures[`${tier}/${width}x${height}`]||0)+1; }
  }
} finally { closeSync(file); }
const summary = [];
for (const tier of ['easy','medium','hard']) for (const [width,height] of [[13,17],[17,19],[21,21]]) {
  const group=rows.filter(x=>x.tier===tier&&x.width===width);
  const dist=field=>{const a=group.map(x=>x.metrics[field]).sort((a,b)=>a-b);return {min:a[0]??null,p50:a[Math.floor(a.length/2)]??null,p90:a[Math.floor(a.length*.9)]??null,max:a.at(-1)??null};};
  summary.push({tier,size:`${width}x${height}`,count:group.length,backtrack:dist('mandatoryBacktrack'),misleading:dist('misleadingBranches'),actions:dist('optimalInputs')});
}
const shortlist = [];
for (const tier of ['easy','medium','hard']) for (const [width,height] of [[13,17],[17,19],[21,21]]) {
  const group = rows.map((row,index)=>({row,index:index+1})).filter(x=>x.row.tier===tier&&x.row.width===width)
    .sort((a,b)=>a.row.metrics.navigationBurden-b.row.metrics.navigationBurden);
  for (const rank of [0,Math.floor(group.length/2),group.length-1]) if (group[rank]) shortlist.push({tier,size:`${width}x${height}`,line:group[rank].index,burden:group[rank].row.metrics.navigationBurden});
}
const shortlistFile = openSync(`${destination}/shortlist.json`, 'wx', 0o600);
try { writeFileSync(shortlistFile,JSON.stringify(shortlist)+'\n'); } finally { closeSync(shortlistFile); }
console.log(JSON.stringify({algorithmVersion,counts:rows.length,failures,summary,shortlist:shortlist.map(({line,...rest})=>rest)}));
