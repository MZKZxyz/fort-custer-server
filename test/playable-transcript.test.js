import {test} from 'node:test';
import assert from 'node:assert/strict';
import {LIMITS,ROUTE_POLICY,parseTranscript,normalizeTranscript,replayTranscript} from '../services/playable/transcript.js';
import {move,findStart} from './fixtures/client-movement.js';
// Test-only grant registry: no competitive power is enabled in runtime admission.
const FIXTURE_ABILITIES=['fixture-hint-v1','fixture-preview-v1'];
const manifest=(abilityIds=[])=>({...ROUTE_POLICY,runClass:abilityIds.length?'assisted':'standard',abilityIds});
const transcript=dirs=>({version:'route-transcript-v1',commands:dirs.map((dir,i)=>({seq:i+1,dir}))});
const run=(grid,dirs,policy=manifest())=>replayTranscript(grid,policy,transcript(dirs),{supportedAbilities:FIXTURE_ABILITIES});
const right=n=>Array(n).fill('right');
test('canonical start, cardinal movement and terminal tipi arrival',()=>{
  const r=run(['S E'],right(2));assert.deepEqual(r.position,[0,2]);assert.equal(r.completed,true);assert.equal(r.commandCount,2);
});
for(const dir of ['up','left','down'])test(`out-of-bounds ${dir} is a no-op, never wraps`,()=>{
  const r=run(['SE'],[dir,'right']);assert.equal(r.blocked,1);assert.deepEqual(r.position,[0,1]);
});
test('walls block; a legal detour reaches the tipi',()=>{
  const r=run(['S#E','   '],['right','down','right','right','up']);assert.equal(r.blocked,1);assert.deepEqual(r.position,[0,2]);
});
test('cannot traverse wall or fire with no equipment merely by reporting finish',()=>{
  assert.throws(()=>run(['S#E'],right(2)),/TRANSCRIPT_INCOMPLETE/);
  assert.throws(()=>run(['SFE'],right(3)),/TRANSCRIPT_INCOMPLETE/);
});
test('pickup, stationary fire clear, then extra step into cleared cell',()=>{
  assert.throws(()=>run(['SXFE'],right(3)),/TRANSCRIPT_INCOMPLETE/);
  const r=run(['SXFE'],right(4));assert.equal(r.pickups,1);assert.equal(r.cleared,1);assert.equal(r.equipment,false);
});
test('equipment is one capacity; full pickup consumed; cannot clear two fires',()=>{
  assert.throws(()=>run(['SXXFFE'],right(10)),/TRANSCRIPT_INCOMPLETE/);
  const r=run(['SXXE'],right(3));assert.equal(r.pickups,2);assert.equal(r.equipment,true);assert.equal(r.grid[0].join(''),'S  E');
});
test('new pickup replenishes consumed equipment',()=>{
  const r=run(['SXFXFE'],right(7));assert.equal(r.cleared,2);assert.equal(r.pickups,2);assert.equal(r.equipment,false);
});
test('revisited pickup does not regenerate and original maze is never mutated',()=>{
  const grid=['SXFE'],before=JSON.stringify(grid);
  const r=run(grid,['right','right','left','right','right','right']);
  assert.equal(r.pickups,1);assert.equal(r.cleared,1);assert.equal(r.equipment,false);assert.equal(JSON.stringify(grid),before);
});
test('loop/revisit of S is legal, repeated direction is a distinct new command',()=>{
  assert.equal(run(['S E'],['right','left','right','right']).completed,true);
});
for(const dir of ['right','left','up'])test(`any command after terminal arrival (${dir}) is rejected`,()=>{
  assert.throws(()=>run(['SE'],['right',dir]),/TRANSCRIPT_AFTER_GOAL/);
});
for(const dir of ['toString','constructor','__proto__','diagonal','RIGHT','',null,1])test(`unknown direction ${String(dir)} fails schema`,()=>{
  assert.throws(()=>run(['SE'],[dir]),/TRANSCRIPT_ORDER_OR_COMMAND/);
});
for(const seqs of [[0],[2],[1,1],[1,3],[2,1],[1,1.5]])test(`command sequence ${seqs} is rejected`,()=>{
  const t={version:'route-transcript-v1',commands:seqs.map(seq=>({seq,dir:'right'}))};
  assert.throws(()=>replayTranscript(['SE'],manifest(),t),/TRANSCRIPT_ORDER_OR_COMMAND/);
});
for(const extra of [{position:[0,1]},{elapsedMs:1},{completed:true},{equipment:true},{at:123}])test(`client field ${Object.keys(extra)[0]} cannot set state or time`,()=>{
  const t=transcript(['right']);Object.assign(t.commands[0],extra);
  assert.throws(()=>replayTranscript(['SE'],manifest(),t),/TRANSCRIPT_ORDER_OR_COMMAND/);
});
test('no finish opcode, version fallback, empty route or partial route',()=>{
  assert.throws(()=>run(['SE'],[]),/TRANSCRIPT_INCOMPLETE/);
  assert.throws(()=>run(['S E'],['right']),/TRANSCRIPT_INCOMPLETE/);
  assert.throws(()=>run(['SE'],['finish']),/TRANSCRIPT_ORDER_OR_COMMAND/);
  assert.throws(()=>replayTranscript(['SE'],manifest(),{version:'unknown',commands:[]}),/TRANSCRIPT_SCHEMA/);
});
for(const grid of [[],['S'],['SSE'],['S E','#'],['S?E'],['E'],['SE'.padEnd(102)]])test(`bad pinned grid ${JSON.stringify(grid).slice(0,24)} is an operational failure`,()=>{
  assert.throws(()=>run(grid,['right']),e=>e.code==='GRID_INVALID'&&e.status===503);
});
test('immutable integrity tier, validator and public label must match manifest',()=>{
  for(const field of ['rulesVersion','integrityTier','validationPolicyVersion','publicLabel']){
    assert.throws(()=>run(['SE'],['right'],{...manifest(),[field]:'changed'}),/POLICY_UNSUPPORTED/);
  }
});
test('standard/assisted grants locked; unknown rule-changing ability is unsupported',()=>{
  assert.equal(run(['SE'],['right'],manifest(['fixture-hint-v1'])).completed,true);
  assert.throws(()=>run(['SE'],['right'],{...manifest(),abilityIds:['fixture-hint-v1']}),/POLICY_UNSUPPORTED/);
  assert.throws(()=>run(['SE'],['right'],manifest(['unimplemented-power'])),/POLICY_UNSUPPORTED/);
});
test('canonical property ordering yields identical transcript hash',()=>{
  const a=normalizeTranscript(transcript(['right']));
  const b=normalizeTranscript({commands:[{dir:'right',seq:1}],version:'route-transcript-v1'});
  assert.equal(a.hash,b.hash);assert.deepEqual(parseTranscript(JSON.stringify(b.normalized)),a.normalized);
});
test('decoded wire byte bound is checked before parse, including whitespace',()=>{
  const json=JSON.stringify(transcript(['right']));
  assert.ok(parseTranscript(json+' '.repeat(LIMITS.maxBytes-Buffer.byteLength(json))));
  assert.throws(()=>parseTranscript(json+' '.repeat(LIMITS.maxBytes-Buffer.byteLength(json)+1)),e=>e.status===413);
  assert.throws(()=>parseTranscript('{'),e=>e.status===400);
});
test('maximum command count is accepted; next command is rejected without truncation',()=>{
  const dirs=[...Array(LIMITS.maxCommands-1).fill('left'),'right'];
  assert.equal(run(['SE'],dirs).commandCount,LIMITS.maxCommands);
  assert.throws(()=>run(['SE'],[...dirs,'right']),e=>e.status===413);
});
test('representative paths agree with pinned client movement fixture',()=>{
  for(const [grid,dirs] of [
    [['SXFE'],right(4)], [['SXFXFE'],right(7)], [['S#E','   '],['right','down','right','right','up']],
    [['SXXE'],['left','right','left','right','right','right']],
  ]) {
    let state={grid:grid.map(row=>[...row]),position:findStart(grid),inventory:[],completed:false};
    for(const dir of dirs)state=move(state,dir).state;
    const result=run(grid,dirs);assert.deepEqual(result.position,state.position);
    assert.deepEqual(result.grid,state.grid);assert.equal(result.equipment,state.inventory.includes('extinguisher'));
    assert.equal(result.completed,state.completed);
  }
});
