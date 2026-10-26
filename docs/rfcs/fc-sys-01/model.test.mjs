import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Sessions, fixtureClock, payloadHash} from './model.mjs';
const actor = (profileId='profile-a', accountId='account-a') => ({accountId, profileId});
function prepared(m, who=actor(), key='create', options) { return m.create(who, key, options); }
function ready(m, s, options={}) { return m.ready(s.actor, s.id, {nonce:s.nonce, ifMatch:s.revision, ...options}); }
function started(m, who=actor(), key='create', options) { const s=prepared(m,who,key,options); ready(m,s); return s; }
function complete(m,s,options={}) { return m.complete(s.actor,s.id,{key:`complete-${s.id}`,ifMatch:s.revision,...options}); }
function decide(m,s,decision='accepted',options={}) { return m.decide(s.actor,s.id,decision,{expectedRevision:s.decisionRevision,...options}); }
function finish(m,s,ms=5000) { m.tick(ms); const result=complete(m,s); decide(m,s); return result; }
function clearHistory(m,who=actor(),date='fixture-date') { m.legacy(who,date,'clear'); }
function abandon(m,s,options={}) { return m.abandon(s.actor,s.id,{ifMatch:s.revision,...options}); }
function receipt(m,s) { return m.captureComplete(s.actor,s.id,{key:`complete-${s.id}`,ifMatch:s.revision}); }

test('lost create ACK recovers same ID and canonical sorted ability payload',()=>{
  const m=new Sessions(),s=prepared(m,actor(),'key',{abilityIds:['b','a']});
  assert.strictEqual(prepared(m,actor(),'key',{abilityIds:['a','b']}),s);
  assert.equal(payloadHash({a:1,b:2}),payloadHash({b:2,a:1}));
  assert.throws(()=>prepared(m,actor(),'key',{date:'other'}),/KEY_CONFLICT/);
});
test('create key is account scoped across subprofiles, not profile scoped',()=>{
  const m=new Sessions(); prepared(m,actor('a'),'same');
  assert.throws(()=>prepared(m,actor('b'),'same'),/KEY_CONFLICT/);
  assert.equal(prepared(m,actor('b'),'different').state,'PREPARED');
  assert.equal(prepared(m,actor('a','account-b'),'same').state,'PREPARED');
});
for(const order of [['first','second'],['second','first']]) test(`create slot linearization ${order.join('/')}`,()=>{
  const m=new Sessions(),s=prepared(m,actor(),order[0]);
  assert.throws(()=>prepared(m,actor(),order[1]),/ACTIVE_SESSION/);
  assert.deepEqual([...m.slots.values()],[s.id]);
});
test('loading excluded; ready ACK and finish uplink charged',()=>{
  const m=new Sessions(),s=prepared(m);m.tick(12000);ready(m,s);m.tick(600+5000+900);
  assert.equal(complete(m,s).elapsedMs,6500);
});
test('lost ready ACK/status preserve start, deadline and revision',()=>{
  const m=new Sessions(),s=started(m),start=s.startedAt,deadline=s.deadline,revision=s.revision;
  m.tick(1000);ready(m,s,{ifMatch:1});
  assert.deepEqual([s.startedAt,s.deadline,s.revision],[start,deadline,revision]);
  assert.equal(m.status(s.actor,s.id).state,'STARTED');
  assert.throws(()=>ready(m,s,{key:'changed'}),/STARTED/);
});
for(const phase of ['prepare','play']) for(const offset of [-1,0,1]) test(`${phase} replay at deadline${offset<0?'': '+'}${offset}`,()=>{
  const m=new Sessions(),s=prepared(m);if(phase==='play')ready(m,s);
  const start=s.startedAt,deadline=s.deadline;m.tick(deadline+offset);
  const recovered=phase==='play'?ready(m,s,{ifMatch:1}):prepared(m);
  assert.equal(recovered.state,offset<0?(phase==='play'?'STARTED':'PREPARED'):'EXPIRED');
  assert.equal(recovered.id,s.id);assert.equal(recovered.startedAt,start);assert.equal(recovered.deadline,deadline);
  assert.equal(m.slots.size,offset<0?1:0);
});
test('nonce/grid and ownership checked; foreign completed result cannot replay',()=>{
  const m=new Sessions(),s=prepared(m);
  assert.throws(()=>ready(m,s,{nonce:'wrong'}),/READY_BINDING/);
  assert.throws(()=>ready(m,s,{gridHash:'wrong'}),/READY_BINDING/);
  ready(m,s);m.tick(5000);complete(m,s);
  for(const who of [actor('other'),actor('profile-a','other-account')]) {
    assert.throws(()=>m.complete(who,s.id,{key:'key'}),/NOT_FOUND/);
    assert.throws(()=>m.status(who,s.id),/NOT_FOUND/);
  }
  assert.throws(()=>m.status(s.actor,'unknown'),/NOT_FOUND/);
});
test('completion rejects caller time and unstarted session',()=>{
  const m=new Sessions(),s=prepared(m);assert.throws(()=>complete(m,s),/PREPARED/);
  ready(m,s);assert.throws(()=>complete(m,s,{elapsedMs:1}),/PAYLOAD/);
});
test('stale If-Match blocks fresh ready/complete; exact replay bypasses stale revision',()=>{
  const m=new Sessions(),s=prepared(m);assert.throws(()=>ready(m,s,{ifMatch:0}),/REVISION/);
  ready(m,s);assert.throws(()=>complete(m,s,{ifMatch:1}),/REVISION/);
  m.tick(5000);const r=complete(m,s);assert.strictEqual(complete(m,s,{ifMatch:1}),r);
});
for(const winner of ['ready','abandon']) test(`fixed-revision ready/abandon race: ${winner}`,()=>{
  const m=new Sessions(),s=prepared(m),revision=s.revision;
  if(winner==='ready') {ready(m,s,{ifMatch:revision});assert.throws(()=>abandon(m,s,{ifMatch:revision}),/REVISION/);}
  else {abandon(m,s,{ifMatch:revision});assert.throws(()=>ready(m,s,{ifMatch:revision}),/ABANDONED/);}
});
for(const winner of ['complete','abandon']) test(`terminal CAS race: ${winner}`,()=>{
  const m=new Sessions(),s=started(m),request=receipt(m,s),revision=s.revision;
  if(winner==='complete') {m.commitComplete(request);assert.throws(()=>abandon(m,s,{ifMatch:revision}),/COMPLETED/);}
  else {abandon(m,s,{ifMatch:revision});assert.throws(()=>m.commitComplete(request),/ABANDONED/);}
});
test('explicit abandon replays and stale cleanup cannot release replacement slot',()=>{
  const m=new Sessions(),a=started(m);abandon(m,a);abandon(m,a,{ifMatch:0});
  const b=prepared(m,actor(),'new');m.release(a);assert.deepEqual([...m.slots.values()],[b.id]);
});
for(const offset of [0,1]) test(`receipt at deadline+${offset} fails even without cleanup`,()=>{
  const m=new Sessions(),s=started(m);m.tick(s.deadline+offset);assert.throws(()=>complete(m,s),/EXPIRED/);
});
test('receipt and guarded write before deadline may commit after deadline',()=>{
  const m=new Sessions(),s=started(m);m.tick(s.deadline-1);const request=receipt(m,s),guardAt=m.now;
  m.tick(2);const r=m.commitComplete(request,{guardAt,committedAt:m.now});
  assert.equal(r.receivedAt,s.deadline-1);assert.equal(r.committedAt,s.deadline+1);
  assert.equal(m.status(s.actor,s.id).state,'COMPLETED');
});
test('receipt before deadline but guarded write at deadline loses',()=>{
  const m=new Sessions(),s=started(m);m.tick(s.deadline-1);const request=receipt(m,s);m.tick(1);
  assert.throws(()=>m.commitComplete(request),/EXPIRED/);assert.equal(s.result,undefined);
});
test('cleanup committed first fences old predeadline receipt and preserves replacement',()=>{
  const m=new Sessions(),s=started(m);m.tick(s.deadline-1);const request=receipt(m,s),guardAt=m.now;m.tick(2);
  assert.equal(m.status(s.actor,s.id).state,'EXPIRED');const next=prepared(m,actor(),'next');
  assert.throws(()=>m.commitComplete(request,{guardAt}),/EXPIRED/);assert.deepEqual([...m.slots.values()],[next.id]);
});
test('failure before commit has no receipt/outbox/key effects; new HTTP retry charges later receipt',()=>{
  const m=new Sessions(),s=started(m);m.tick(5000);const request=receipt(m,s);
  assert.throws(()=>m.commitComplete(request,{commit:false}),/BEFORE_COMMIT/);
  assert.equal(m.events.length,0);assert.equal(m.completionKeys.size,0);assert.equal(s.result,undefined);
  m.tick(1500);assert.equal(complete(m,s).elapsedMs,6500);
});
test('internal transaction retry retains captured receipt while commit time moves',()=>{
  const m=new Sessions(),s=started(m);m.tick(5000);const request=receipt(m,s);m.tick(1500);
  assert.equal(m.commitComplete(request).elapsedMs,5000);
});
test('unknown/lost commit ACK resolves winner after expiry and replacement start',()=>{
  const m=new Sessions(),s=started(m);m.tick(5000);const request=receipt(m,s),saved=m.commitComplete(request);
  const newer=started(m,actor(),'next');m.tick(9000000);
  assert.strictEqual(m.commitComplete(request),saved);assert.strictEqual(complete(m,s,{key:'alternate'}),saved);
  assert.equal(saved.receivedAt,5000);assert.equal(newer.result,undefined);
  assert.equal(m.events.filter(e=>e.type==='receipt').length,1);
});
test('distinct completion keys share one immutable result; account key collision fails',()=>{
  const m=new Sessions(),a=started(m);m.tick(5000);const r=complete(m,a,{key:'shared'});
  assert.strictEqual(complete(m,a,{key:'other',ifMatch:0}),r);
  const b=started(m,actor('b'),'b');m.tick(5000);
  assert.throws(()=>complete(m,b,{key:'shared'}),/KEY_CONFLICT/);
  assert.equal(b.result,undefined);assert.ok(Object.isFrozen(r.clockEvidence.receipt));
});
test('twenty serialized duplicates produce one receipt, no entitlement until acceptance',()=>{
  const m=new Sessions(),s=started(m);m.tick(5000);const r=complete(m,s);
  for(let n=0;n<20;n++)assert.strictEqual(complete(m,s),r);
  assert.equal(m.events.length,1);assert.equal(m.entitlements.size,0);
});
for(const kind of ['negative','epoch','missing']) test(`irreparable clock evidence (${kind}) cannot be accepted`,()=>{
  const m=new Sessions(),s=started(m);m.tick(kind==='negative'?-1:5000);
  const clock=fixtureClock();if(kind==='epoch')clock.epoch='other';if(kind==='missing')clock.evidenceId='';
  const r=complete(m,s,{clock});assert.equal(r.clockDisposition,'irreparable');assert.equal(s.decision,'quarantined');
  assert.throws(()=>decide(m,s,'accepted',{authority:'reviewer',repair:{independentlyVerified:true,evidenceId:'repair',epoch:'fixture-epoch',uncertaintyMs:1}}),/CLOCK_IRREPARABLE/);
  assert.equal(m.project().length,0);if(kind==='negative')assert.equal(r.elapsedMs,-1);
});
for(const at of ['start','receipt']) test(`positive unhealthy ${at} clock requires audited independent repair`,()=>{
  const m=new Sessions(),s=prepared(m),clock={...fixtureClock(),healthy:false};
  ready(m,s,at==='start'?{clock}:{});m.tick(5000);
  const r=complete(m,s,at==='receipt'?{clock}:{});
  assert.equal(r.elapsedMs,5000);assert.equal(s.decision,'quarantined');
  assert.throws(()=>decide(m,s),/CLOCK_REVIEW_REQUIRED/);
  assert.throws(()=>decide(m,s,'accepted',{authority:'reviewer',repair:{evidenceId:'bare-assertion'}}),/CLOCK_REVIEW_REQUIRED/);
  decide(m,s,'accepted',{authority:'reviewer',reason:'independent clock correlation',repair:{independentlyVerified:true,evidenceId:'fixture-correlation',epoch:'fixture-epoch',uncertaintyMs:2}});
  assert.equal(m.project().length,1);assert.equal(s.audit[0].repair.evidenceId,'fixture-correlation');
  assert.strictEqual(s.result,r);assert.equal(r.clockDisposition,'review-required');
});
test('excess uncertainty quarantines; adjudication authority/revision and repair bounds enforced',()=>{
  const m=new Sessions(),s=started(m);m.tick(5000);complete(m,s,{clock:{...fixtureClock(),uncertaintyMs:11}});
  assert.throws(()=>decide(m,s,'accepted',{authority:'player'}),/AUTHORITY/);
  assert.throws(()=>decide(m,s,'accepted',{expectedRevision:9}),/ADJUDICATION_REVISION/);
  assert.throws(()=>decide(m,s,'accepted',{authority:'reviewer',repair:{independentlyVerified:true,evidenceId:'repair',epoch:'fixture-epoch',uncertaintyMs:11}}),/CLOCK_REVIEW_REQUIRED/);
});
test('receipt-only acceptance cannot establish movement or a universal three-second floor',()=>{
  const m=new Sessions(),s=started(m);m.tick(2400);const r=complete(m,s);assert.equal(m.project().length,0);
  decide(m,s);assert.equal(m.project().length,1);assert.equal(r.integrityTier,'receipt-only-client-claimed-v1');
  assert.equal(r.validationPolicyVersion,'receipt-policy-v1');
});
test('rejected first receipt does not deny a later accepted successful date',()=>{
  const m=new Sessions();clearHistory(m);const a=started(m);m.tick(5000);const frozen=complete(m,a);decide(m,a,'rejected');
  const b=started(m,actor(),'next');finish(m,b);assert.equal(m.entitlement(actor(),'fixture-date').resultId,b.result.id);
  assert.equal(frozen.entitlementStatus,'unresolved-at-receipt');
});
for(const initial of ['pending','quarantined']) test(`${initial} first receipt cannot block accepted replay; late acceptance cannot double consume`,()=>{
  const m=new Sessions();clearHistory(m);const a=started(m);m.tick(5000);complete(m,a);if(initial==='quarantined')decide(m,a,initial);
  const b=started(m,actor(),'next');finish(m,b);const token=m.entitlement(actor(),'fixture-date');
  const terminal=m.consumeOpportunity(actor(),'fixture-date',token);decide(m,a);
  assert.strictEqual(m.consumeOpportunity(actor(),'fixture-date',token),terminal);
  assert.equal(terminal.resultId,b.result.id);assert.equal(m.entitlements.size,1);
});
for(const order of [['a','b'],['b','a']]) test(`concurrent accepted date claims linearization ${order.join('/')}`,()=>{
  const m=new Sessions();clearHistory(m);const a=started(m);m.tick(5000);complete(m,a);
  const b=started(m,actor(),'next');m.tick(3000);complete(m,b);const all={a,b};
  for(const name of order)decide(m,all[name]);
  const token=m.entitlement(actor(),'fixture-date');assert.equal(token.resultId,all[order[0]].result.id);
  assert.equal(m.consumeOpportunity(actor(),'fixture-date',token).state,'consumed');
  assert.equal(m.entitlements.size,1);
});
test('accepted then rejected before consumption reassigns and fences old outbox token',()=>{
  const m=new Sessions();clearHistory(m);const a=started(m);finish(m,a);const stale=m.entitlement(actor(),'fixture-date');
  const b=started(m,actor(),'next');finish(m,b);decide(m,a,'rejected');
  const current=m.entitlement(actor(),'fixture-date');assert.equal(current.resultId,b.result.id);
  assert.throws(()=>m.consumeOpportunity(actor(),'fixture-date',stale),/STALE_ENTITLEMENT/);
  m.consumeOpportunity(actor(),'fixture-date',current);decide(m,a);assert.equal(m.entitlement(actor(),'fixture-date').resultId,b.result.id);
});
test('invalidation with no accepted fallback releases eligibility; reacceptance cannot reopen consumed date',()=>{
  const m=new Sessions();clearHistory(m);const s=started(m);finish(m,s);decide(m,s,'rejected');
  assert.equal(m.entitlement(actor(),'fixture-date').state,'available');decide(m,s);
  m.consumeOpportunity(actor(),'fixture-date',m.entitlement(actor(),'fixture-date'));decide(m,s,'rejected');decide(m,s);
  assert.equal(m.entitlement(actor(),'fixture-date').state,'consumed');
});
test('catalog exhausted consumes permanent opportunity; no later replay reroll',()=>{
  const m=new Sessions();clearHistory(m);const a=started(m);finish(m,a);const token=m.entitlement(actor(),'fixture-date');
  const terminal=m.consumeOpportunity(actor(),'fixture-date',token,'exhausted');
  const b=started(m,actor(),'next');finish(m,b);assert.strictEqual(m.consumeOpportunity(actor(),'fixture-date',token),terminal);
});
for(const history of ['awarded','exhausted','unknown','absent']) test(`legacy ${history} blocks fresh opportunity without rewriting snapshot`,()=>{
  const m=new Sessions(),snapshot={latestSeconds:'12.000',rewards:{retired:3},completedWithoutSnapshot:true};
  if(history!=='absent')m.legacy(actor(),'fixture-date',history,snapshot);
  const before=JSON.stringify([...m.history]);finish(m,started(m));
  assert.equal(m.entitlement(actor(),'fixture-date').state,'legacy-held');assert.equal(JSON.stringify([...m.history]),before);
  assert.equal(m.project().length,1);assert.throws(()=>m.consumeOpportunity(actor(),'fixture-date',{revision:0}),/STALE_ENTITLEMENT/);
});
test('profiles and dates have independent eligibility; standard and assisted share same date entitlement',()=>{
  const m=new Sessions();clearHistory(m);clearHistory(m,actor('b'));clearHistory(m,actor(),'other-date');
  finish(m,started(m));finish(m,started(m,actor(),'assisted',{abilityIds:['route-help']}));
  finish(m,started(m,actor('b'),'b'));finish(m,started(m,actor(),'other',{date:'other-date'}));
  assert.equal(m.entitlements.size,3);assert.equal(m.project().length,4);
});
test('ability grants/class locked at creation; access controls need no competitive grant',()=>{
  const m=new Sessions(),s=started(m);assert.equal(s.manifest.runClass,'standard');
  assert.throws(()=>s.manifest.abilityIds.push('route-help'),TypeError);abandon(m,s);
  const assisted=started(m,actor(),'new',{abilityIds:['route-help']});assert.equal(assisted.manifest.runClass,'assisted');
});
test('reload abandons explicitly then allows fresh ranked replay from S',()=>{
  const m=new Sessions(),a=started(m);m.tick(12000);assert.equal(m.status(a.actor,a.id).startedAt,0);
  abandon(m,a);const b=started(m,actor(),'reload');finish(m,b);assert.equal(m.project()[0].attemptId,b.id);
});
for(const order of [['a','b'],['b','a']]) test(`equal-duration tie uses receipt time despite adjudication order ${order.join('/')}`,()=>{
  const m=new Sessions(),a=started(m);m.tick(5000);complete(m,a);const b=started(m,actor(),'next');m.tick(5000);complete(m,b);
  const all={a,b};for(const name of order){m.tick(100);decide(m,all[name]);}
  assert.equal(m.project()[0].attemptId,a.id);assert.equal(a.audit[0].adjudicatedAt>0,true);
});
test('equal elapsed and receipt tie uses result ID, independent of acceptance order',()=>{
  const m=new Sessions(),a=started(m),b=started(m,actor('b'),'b');m.tick(5000);complete(m,a);complete(m,b);
  decide(m,b);decide(m,a);assert.deepEqual(m.project().map(r=>r.id),[a.result.id,b.result.id].sort());
});
test('slower replay cannot replace best; invalidated winner falls back; empty board repairs',()=>{
  const m=new Sessions(),a=started(m);finish(m,a);const b=started(m,actor(),'next');finish(m,b,3000);
  const c=started(m,actor(),'slower');finish(m,c,9000);assert.equal(m.project()[0].attemptId,b.id);
  decide(m,b,'rejected');assert.equal(m.project()[0].attemptId,a.id);
  decide(m,a,'quarantined');decide(m,c,'rejected');assert.equal(m.project().length,0);
});
test('stale projection cannot publish after invalidation, even after reading newer board revision',()=>{
  const m=new Sessions(),s=started(m);finish(m,s);const stale=m.projectionSnapshot();
  decide(m,s,'rejected');m.project();const newerBoardRevision=m.boardRevision;
  assert.throws(()=>m.publishProjection({...stale,boardRevision:newerBoardRevision}),/STALE_PROJECTION/);
  assert.equal(m.best.length,0);m.project();m.project();assert.equal(m.best.length,0);
});
test('competition eras and assisted classes stay separate',()=>{
  const m=new Sessions();finish(m,started(m));finish(m,started(m,actor(),'era',{competition:'fixture-other-era'}));
  finish(m,started(m,actor(),'assist',{abilityIds:['route-help']}));assert.equal(m.project().length,3);
});
test('same create intent retains original competition manifest after server policy changes',()=>{
  const m=new Sessions(),s=prepared(m);
  assert.strictEqual(prepared(m,actor(),'create',{competition:'fixture-other-era'}),s);
  assert.equal(s.manifest.competitionVersion,'fixture-equal-window');
});
test('rules version is bound at ready',()=>{
  const m=new Sessions(),s=prepared(m);
  assert.throws(()=>ready(m,s,{rulesVersion:'other-rules'}),/READY_BINDING/);
  assert.equal(s.state,'PREPARED');
});
test('healthy uncertainty at approved fixture bound remains pending, not auto-accepted',()=>{
  const m=new Sessions(),s=started(m);m.tick(5000);
  complete(m,s,{clock:{...fixtureClock(),uncertaintyMs:10}});
  assert.equal(s.decision,'pending');assert.equal(m.project().length,0);
});
test('maze date, not midnight receipt day, determines entitlement',()=>{
  const m=new Sessions(),date='synthetic-archive-date';clearHistory(m,actor(),date);
  m.tick(86399000);const a=started(m,actor(),'archive',{date});finish(m,a,2000);
  const original=m.entitlement(actor(),date);assert.equal(a.result.receivedAt,86401000);
  const b=started(m,actor(),'replay',{date});finish(m,b);assert.equal(m.entitlement(actor(),date).resultId,original.resultId);
  assert.equal(m.entitlements.size,1);
});
test('reversed and duplicated adjudication notifications recompute current source state only',()=>{
  const m=new Sessions(),a=started(m);finish(m,a);const b=started(m,actor(),'next');finish(m,b,3000);
  decide(m,b,'rejected');const notifications=m.events.filter(e=>e.type==='adjudication').reverse();
  // The oracle intentionally has no event consumer/dedup implementation.
  for(const event of [...notifications,...notifications]) {
    assert.ok(event.revision>=1);assert.equal(m.project()[0].attemptId,a.id);
  }
});
test('create/ready replay after completion returns terminal state and original start',()=>{
  const m=new Sessions(),s=started(m);finish(m,s);const revision=s.revision;m.tick(9000000);
  assert.equal(prepared(m).state,'COMPLETED');assert.equal(ready(m,s,{ifMatch:1}).state,'COMPLETED');
  assert.equal(s.startedAt,0);assert.equal(s.revision,revision);assert.equal(m.slots.size,0);
});
