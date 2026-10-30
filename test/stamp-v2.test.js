import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { generate, verify, transition, initialState, solve } from '../lib/maze/stamp-v2.js';
import { seededRandom } from '../lib/maze/random-v2.js';
import { generateDaily } from '../lib/maze/engine.js';
import { move, findStart } from './fixtures/client-movement.js';

// Independent graph/action oracle: walk S->E, E->P, interact, P->E using its own BFS.
function shortest(grid, from, to) {
  const q = [[from, []]], seen = new Set([from.join()]);
  for (let i = 0; i < q.length; i++) {
    const [p, steps] = q[i]; if (p.join() === to.join()) return steps;
    for (const [name, dr, dc] of [['up',-1,0],['down',1,0],['left',0,-1],['right',0,1]]) {
      const n = [p[0]+dr,p[1]+dc]; if (!grid[n[0]]?.[n[1]] || grid[n[0]][n[1]] === '#' || seen.has(n.join())) continue;
      seen.add(n.join()); q.push([n,[...steps,name]]);
    }
  }
  throw Error('unreachable');
}
function point(grid, tile) { for (let r=0;r<grid.length;r++) for(let c=0;c<grid[r].length;c++) if(grid[r][c]===tile) return [r,c]; }
function walk(grid, state, actions) { return actions.reduce((s,a)=>transition(grid,true,s,a),state); }
test('v2 deterministic stamp state, exit recovery and independent route oracle', () => {
  for (const tier of ['easy','medium','hard']) for (const [width,height] of [[13,17],[17,19],[21,21]]) for(let i=0;i<12;i++) {
    const seed = `disposable-fixture-${tier}-${width}-${i}`;
    const x = generate({seed,tier,config:{width,height}});
    assert.deepEqual(x,generate({seed,tier,config:{width,height}}));
    assert.equal(verify(x.grid,tier).code,'ACCEPTED');
    const s=point(x.grid,'S'),e=point(x.grid,'E'),p=point(x.grid,'P');
    const direct=shortest(x.grid,s,e), result=solve(x.grid,tier!=='easy');
    assert.equal(result.solvable,true);
    if(tier==='easy') {
      assert.equal(p,undefined); assert.equal(result.actions.length,direct.length);
      const client = direct.reduce((state,a)=>move(state,a).state,{grid:x.grid,position:findStart(x.grid),inventory:[],completed:false});
      assert.equal(client.completed,true);
    } else {
      assert.ok(p); assert.equal(result.actions.filter(a=>a==='interact').length,1);
      let state=walk(x.grid,initialState(x.grid),direct);
      assert.equal(state.completed,false); assert.equal(state.stamped,false);
      const toP=shortest(x.grid,e,p); state=walk(x.grid,state,toP);
      assert.deepEqual(transition(x.grid,true,state,'interact'),{...state,stamped:true});
      state=transition(x.grid,true,state,'interact'); assert.deepEqual(transition(x.grid,true,state,'interact'),state);
      state=walk(x.grid,state,shortest(x.grid,p,e)); assert.equal(state.completed,true);
      assert.equal(result.actions.length,shortest(x.grid,s,p).length+shortest(x.grid,p,e).length+1);
      assert.equal(x.metrics.mandatoryBacktrack,2*x.metrics.branchDepth);
      assert.ok(tier==='medium'?x.metrics.branchDepth<=8:x.metrics.branchDepth>=9);
      assert.ok(!x.grid.flat().includes('F')&&!x.grid.flat().includes('X'));
    }
  }
});
test('malformed and bypass layouts fail, and legacy v1 bytes remain stable', () => {
  const x=generate({seed:'disposable',tier:'medium'});
  const invalid=x.grid.map(row=>[...row]); const p=point(invalid,'P'); invalid[p[0]][p[1]]=' ';
  assert.equal(verify(invalid,'medium').code,'INVALID_TILES');
  const v1=generateDaily({date:'2028-01-01',seed:'legacy-regression'});
  assert.equal(v1.gridHash,'0733635438a87ca5ee6cf57fd25bb9d06e4c36dfb641f0e7f5067b00384de87b');
});
// A fixed tree with a short S-E route and one side corridor. Moving P changes
// depth without changing the topology; the optional spur is a misleading branch.
function tierFixture(depth, spur = false) {
  const grid = Array.from({ length: 14 }, () => Array(7).fill('#'));
  for (let c = 1; c <= 3; c++) grid[1][c] = ' ';
  for (let r = 2; r <= 10; r++) grid[r][2] = ' ';
  if (spur) grid[4][3] = ' ';
  grid[1][1] = 'S'; grid[1][3] = 'E'; grid[depth + 1][2] = 'P';
  return grid;
}
test('verifier enforces tier identity and both depth boundaries independently', () => {
  const medium = generate({ seed: 'tier-spoof-medium', tier: 'medium' });
  const hard = generate({ seed: 'tier-spoof-hard', tier: 'hard' });
  assert.equal(verify(medium.grid, 'hard').code, 'HARD_BRANCH_DEPTH_REJECTED');
  assert.equal(verify(hard.grid, 'medium').code, 'MEDIUM_BRANCH_DEPTH_REJECTED');
  assert.equal(verify(medium.grid, 'medium').code, 'ACCEPTED');
  assert.equal(verify(hard.grid, 'hard').code, 'ACCEPTED');
  for (const depth of [2, 8]) assert.equal(verify(tierFixture(depth), 'medium').code, 'ACCEPTED');
  for (const depth of [1, 9]) assert.equal(verify(tierFixture(depth), 'medium').code, 'MEDIUM_BRANCH_DEPTH_REJECTED');
  assert.equal(verify(tierFixture(8, true), 'hard').code, 'HARD_BRANCH_DEPTH_REJECTED');
  assert.equal(verify(tierFixture(9), 'hard').code, 'HARD_MISLEADING_BRANCH_REJECTED');
  assert.equal(verify(tierFixture(9, true), 'hard').code, 'ACCEPTED');
  const easy = generate({ seed: 'tier-spoof-easy', tier: 'easy' });
  assert.equal(verify(easy.grid, 'easy').code, 'ACCEPTED');
  assert.equal(verify(easy.grid, 'medium').code, 'INVALID_TILES');
  assert.equal(verify(tierFixture(2), 'easy').code, 'INVALID_TILES');
});
test('v2 random stream has independent deterministic 256-bit state',()=>{
  const a=seededRandom('a'),b=seededRandom('a'),c=seededRandom('b');
  const av=Array.from({length:12},()=>a()); assert.deepEqual(av,Array.from({length:12},()=>b())); assert.notDeepEqual(av,Array.from({length:12},()=>c()));
  assert.ok(av.every(v=>v>=0&&v<1));
});
test('private experiment refuses repo and overwrite, emits aggregates only', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const base = mkdtempSync(join(tmpdir(),'stamp-v2-private-'));
  const repo = new URL('..',import.meta.url).pathname;
  const script = join(repo,'tools/year-ahead/stamp-experiment.js');
  const deny = spawnSync(process.execPath,[script,join(repo,'forbidden'), '1'],{encoding:'utf8'});
  assert.notEqual(deny.status,0);
  const root=join(base,'sample');
  const ok=spawnSync(process.execPath,[script,root,'1'],{encoding:'utf8'});
  assert.equal(ok.status,0,ok.stderr);
  const output=JSON.parse(ok.stdout);
  assert.equal(output.counts,9); assert.equal(output.failures && Object.keys(output.failures).length,0);
  assert.ok(!JSON.stringify(output).includes('seed'));
  const record=JSON.parse(readFileSync(join(root,'sample.jsonl'),'utf8').split('\n')[0]);
  assert.equal(record.seed.length,64);
  assert.ok(!ok.stdout.includes(record.seed));
  const overwrite=spawnSync(process.execPath,[script,root,'1'],{encoding:'utf8'});
  assert.notEqual(overwrite.status,0);
});
