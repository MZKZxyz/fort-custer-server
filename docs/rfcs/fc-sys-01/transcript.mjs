// Standalone design oracle. No application imports or network/DB side effects.
import {createHash} from 'node:crypto';
export const LIMITS = Object.freeze({maxCommands:65536,maxBytes:2097152,maxDimension:101});
export const ROUTE_POLICY = Object.freeze({rulesVersion:'cardinal-fire-v1',
  integrityTier:'server-timed-legal-route-v1',validationPolicyVersion:'route-replay-v1',
  publicLabel:'Server-timed · route validated'});
// Synthetic information-only grants, not an authorization of production abilities.
export const FIXTURE_ABILITIES = Object.freeze(['fixture-hint-v1','fixture-preview-v1']);
const directions = new Map([['up',[-1,0]],['down',[1,0]],['left',[0,-1]],['right',[0,1]]]);
export function fail(code,status=422) { throw Object.assign(new Error(code),{code,status}); }
const exact = (value,keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(k=>Object.hasOwn(value,k));
export function compileGrid(grid) {
  if (!Array.isArray(grid) || !grid.length || grid.length>LIMITS.maxDimension) fail('GRID_INVALID',503);
  const rows=grid.map(row=>typeof row==='string'?[...row]:Array.isArray(row)?[...row]:[]), width=rows[0].length;
  if (!width || width>LIMITS.maxDimension || rows.some(row=>row.length!==width)) fail('GRID_INVALID',503);
  let start,goal;
  for(let r=0;r<rows.length;r++)for(let c=0;c<width;c++) {
    const tile=rows[r][c];if(!['#',' ','S','E','F','X'].includes(tile))fail('GRID_INVALID',503);
    if(tile==='S') {if(start)fail('GRID_INVALID',503);start=[r,c];}
    if(tile==='E') {if(goal)fail('GRID_INVALID',503);goal=[r,c];}
  }
  if(!start||!goal)fail('GRID_INVALID',503);
  return {rows,start,goal};
}
export function checkManifest(manifest, supportedAbilities=[]) {
  if (!manifest || !Object.entries(ROUTE_POLICY).every(([key,value])=>manifest[key]===value)
    || !Array.isArray(manifest.abilityIds) || new Set(manifest.abilityIds).size!==manifest.abilityIds.length
    || manifest.abilityIds.some(id=>!supportedAbilities.includes(id))
    || manifest.runClass!==(manifest.abilityIds.length?'assisted':'standard')) fail('POLICY_UNSUPPORTED',503);
}
export function normalizeTranscript(transcript) {
  if (!exact(transcript,['version','commands']) || transcript.version!=='route-transcript-v1'
    || !Array.isArray(transcript.commands)) fail('TRANSCRIPT_SCHEMA',400);
  if (transcript.commands.length>LIMITS.maxCommands) fail('TRANSCRIPT_TOO_LARGE',413);
  const commands=transcript.commands.map((command,index)=>{
    if(!exact(command,['seq','dir']) || !Number.isSafeInteger(command.seq) || command.seq!==index+1
      || !directions.has(command.dir)) fail('TRANSCRIPT_ORDER_OR_COMMAND',400);
    return {seq:command.seq,dir:command.dir};
  });
  const normalized={version:'route-transcript-v1',commands};
  const encoded=JSON.stringify(normalized);
  if(Buffer.byteLength(encoded,'utf8')>LIMITS.maxBytes)fail('TRANSCRIPT_TOO_LARGE',413);
  return {normalized,hash:createHash('sha256').update(encoded).digest('hex')};
}
export function parseTranscript(raw) {
  // Production must enforce decoded wire bytes before JSON parsing as well.
  if(typeof raw!=='string')fail('TRANSCRIPT_SCHEMA',400);
  if(Buffer.byteLength(raw,'utf8')>LIMITS.maxBytes)fail('TRANSCRIPT_TOO_LARGE',413);
  let decoded;try{decoded=JSON.parse(raw);}catch{fail('TRANSCRIPT_SCHEMA',400);}
  return normalizeTranscript(decoded).normalized;
}
export function replayTranscript(grid,manifest,transcript,{supportedAbilities=[]}={}) {
  checkManifest(manifest,supportedAbilities);
  const {rows,start,goal}=compileGrid(grid), {normalized,hash}=normalizeTranscript(transcript);
  let [r,c]=start, equipment=false, completed=false, blocked=0,pickups=0,cleared=0;
  for(const {dir} of normalized.commands) {
    if(completed)fail('TRANSCRIPT_AFTER_GOAL');
    const [dr,dc]=directions.get(dir), nr=r+dr,nc=c+dc, tile=rows[nr]?.[nc];
    if(tile===undefined||tile==='#'||tile==='F'&&!equipment){blocked++;continue;}
    if(tile==='F') {equipment=false;rows[nr][nc]=' ';cleared++;continue;} // stationary action
    r=nr;c=nc;
    if(tile==='X'){equipment=true;rows[r][c]=' ';pickups++;} // one capacity, pickup removed even if full
    if(tile==='E')completed=true;
  }
  if(!completed)fail('TRANSCRIPT_INCOMPLETE');
  return {transcriptHash:hash,commandCount:normalized.commands.length,position:[r,c],equipment,
    pickups,cleared,blocked,completed:r===goal[0]&&c===goal[1],grid:rows};
}
