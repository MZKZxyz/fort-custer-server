import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import express from 'express';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import Maze from '../models/Maze.js';
import RewardItem from '../models/RewardItem.js';
import { PlayableRepository, COLLECTIONS } from '../services/playable/repository.js';
import { replicaSet, until } from '../tools/transaction-feasibility/replica-set.mjs';
import { fixturePublications } from '../tools/test-support/legacy-publications.mjs';

const secret = 'synthetic-shared-reward-key', date = '2025-05-26', nextDate = '2025-05-27', epochId = 'synthetic-compatible-epoch';
const publicationPolicy = fixturePublications([[date, [['S', 'E']]], [nextDate, [['S', 'E']]]]);
const proof = { version: 'route-transcript-v1', commands: [{ seq: 1, dir: 'right' }] };
let rs, repo, bundle, factory, defaultMaze, defaultUsers, server, base, user, actor, token, hook, now, health, children = [];
const clock = { sample: () => ({ at: now, epoch: 'synthetic-clock', healthy: health, uncertaintyMs: 1, evidenceId: 'synthetic-monitor' }) };
const item = id => ({ id, name: id, image: 'synthetic.png', description: 'Synthetic fixture', category: 'artifact', rarity: 'common' });
async function req(path, body, { auth = token, profile = actor?.profileId, ifMatch, url = base, method = body === undefined ? 'GET' : 'POST' } = {}) {
  const response = await fetch(url + path, { method, headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json',
    'X-Fort-Custer-Protocol': 'session-v2', 'X-Fort-Custer-Capabilities': 'route-transcript-v1',
    ...(ifMatch === undefined ? {} : { 'If-Match': `"${ifMatch}"` }) },
    ...(body === undefined ? {} : { body: JSON.stringify({ ...(profile ? { subProfileId: profile } : {}), ...body }) }) });
  const text = await response.text(); return { status: response.status, body: text ? JSON.parse(text) : null };
}
async function addProfile(name = 'Synthetic profile', extras = {}) {
  const response = await req('/users/subprofile', { name, ...extras }, { profile: null });
  assert.equal(response.status, 201, JSON.stringify(response.body)); return response.body.at(-1)._id;
}
async function v1Start(d = date, profile = actor.profileId) {
  const response = await req('/maze/start', { date: d }, { profile }); assert.equal(response.status, 200, JSON.stringify(response.body));
  const saved = await User.findById(user.id), sub = saved.subProfiles.id(profile);
  const index = sub.attempts.get(d).length - 1;
  await User.collection.updateOne({ _id: user._id }, { $set: { [`subProfiles.${saved.subProfiles.indexOf(sub)}.attempts.${d}.${index}.started`]: new Date(Date.now() - 10000) } });
  return response.body.attemptId;
}
async function v2Start(d = date, profile = actor.profileId, key = 'create-key') {
  const created = await req('/api/v2/sessions', { date: d, createKey: key }, { profile }); assert.equal(created.status, 200, JSON.stringify(created.body));
  now += 10; const s = created.body;
  const ready = await req(`/api/v2/sessions/${s.attemptId}/ready`, { key: 'ready-key', nonce: s.nonce, gridHash: s.gridHash,
    rulesVersion: s.manifest.rulesVersion }, { profile, ifMatch: s.revision }); assert.equal(ready.status, 200, JSON.stringify(ready.body)); return ready.body;
}
const v1Complete = (attemptId, d = date, options = {}) => req('/maze/complete', { date: d, ...(attemptId ? { attemptId } : {}) }, options);
const v2Complete = (s, options = {}) => req(`/api/v2/sessions/${s.attemptId}/complete`, { completionKey: 'complete-key', transcript: proof }, { ifMatch: s.revision, ...options });
async function inventory(profile = actor.profileId) { return (await User.findById(user.id)).subProfiles.id(profile).rewards.toJSON(); }
function barrier(stage) {
  let enter, release, once = false; const entered = new Promise(r => { enter = r; }), waiting = new Promise(r => { release = r; });
  hook = async observed => { if (observed === stage && !once) { once = true; enter(); await waiting; } };
  return { entered, release };
}
async function invariants(profile = actor.profileId, d = date) {
  await repo.tx(async session => {
    const scope = { accountId: user.id, profileId: profile, date: d };
    const ledger = await repo.c('dateLedger').findOne(scope, { session }); assert.ok(ledger);
    assert.equal(await repo.c('dateLedger').countDocuments(scope, { session }), 1);
    const grant = await repo.c('grants').findOne(scope, { session });
    if (grant) {
      assert.equal(ledger.grantId, grant._id); assert.equal(ledger.state, grant.status === 'awarded' ? 'consumed' : 'exhausted');
      assert.equal(await repo.c('grants').countDocuments(scope, { session }), 1);
      const saved = await User.collection.findOne({ _id: user._id }, { session });
      const rewards = saved.subProfiles.find(p=>p._id.toString()===profile).rewards;
      if (grant.reward) assert.equal(rewards[grant.reward.id], 1);
      const event = await repo.c('outbox').findOne({ _id: `settled:${grant._id}` }, { session }); assert.ok(event);
      assert.equal(event.ledgerRevision, ledger.revision);
      assert.equal((await repo.c('outbox').findOne({ _id: grant._id }, { session })).state, 'settled');
    } else assert.equal(ledger.grantId, null);
  });
}
before(async () => {
  process.env.JWT_SECRET = secret;
  ({ createCompatibleBundle: factory } = await import('../services/collectibles/bundle.js'));
  const { createMazeRouter } = await import('../routes/mazeRoutes.js');
  defaultMaze = createMazeRouter({ legacy: publicationPolicy });
  ({ default: defaultUsers } = await import('../routes/userRoutes.js'));
  rs = await replicaSet(); await mongoose.connect(rs.uri);
  repo = new PlayableRepository(mongoose.connection.getClient(), mongoose.connection.db); await repo.provision();
  await User.init(); await Maze.init(); await RewardItem.init();
}, { timeout: 40000 });
after(async () => { await mongoose.disconnect(); await rs?.close(); });
beforeEach(async () => {
  for (const name of COLLECTIONS) await repo.c(name).deleteMany({});
  await Promise.all([User.deleteMany({}), Maze.deleteMany({}), RewardItem.deleteMany({})]);
  await repo.c('writerEpochs').insertOne({ _id: epochId, version: 'shared-date-v1', state: 'active', revision: 0,
    cutoverAt: Date.parse(`${date}T00:00:00Z`), legacyDateCeiling: date, evidenceRef: 'synthetic-reviewed-cutover' });
  await Maze.create({ date, seed: 'synthetic', grid: [['S', 'E']], width: 2, height: 1 });
  await RewardItem.create([item('alpha'), item('beta'), item('gamma')]);
  user = await User.create({ email: 'synthetic@example.invalid', password: 'unused', subProfiles: [] });
  token = jwt.sign({ id: user.id }, secret); actor = { accountId: user.id };
  now = Date.now(); health = true; hook = async () => {};
  repo = new PlayableRepository(mongoose.connection.getClient(), mongoose.connection.db, { hook: stage=>hook(stage) });
  bundle = factory({ repository: repo, epochId, secret, clock, choose: ()=>0, admissionEnabled: true, publicationPolicy });
  const app = express(); app.use('/api/v2', bundle.v2); app.use(express.json()); app.use('/users', bundle.users); app.use('/maze', bundle.maze);
  app.use('/off/users', defaultUsers); app.use('/off/maze', defaultMaze);
  server = app.listen(0, '127.0.0.1'); await new Promise(r=>server.once('listening',r)); base=`http://127.0.0.1:${server.address().port}`;
  actor.profileId = await addProfile();
});
afterEach(async () => {
  await rs.failOff(); server.closeAllConnections(); await new Promise(r=>server.close(r));
  for (const child of children) if (child.exitCode===null && child.signalCode===null) { const done=new Promise(r=>child.once('exit',r)); child.kill('SIGKILL'); await done; }
  children=[];
});

test('genuine compatible registration/profile creation establishes trusted archive eligibility', async () => {
  const registered = await req('/users/register', { email:'new-synthetic@example.invalid',password:'synthetic-password' }, { profile:null });
  assert.equal(registered.status,201);
  const signed = await req('/users/login', { email:'new-synthetic@example.invalid',password:'synthetic-password' }, { profile:null });
  assert.equal(signed.status,200);
  const profile = await req('/users/subprofile', { name:'New player', _id:actor.profileId, collectibleWriterVersion:'forged' }, { auth:signed.body.token,profile:null });
  assert.equal(profile.status,201); const id=profile.body[0]._id; assert.notEqual(id,actor.profileId);
  const owner=jwt.verify(signed.body.token,secret).id;
  assert.ok(await repo.c('profileOrigins').findOne({ accountId:owner,profileId:id,version:'shared-date-v1' }));
  const started=await req('/maze/start',{date},{auth:signed.body.token,profile:id}); assert.equal(started.status,200);
  await User.collection.updateOne({_id:new mongoose.Types.ObjectId(owner)},{$set:{[`subProfiles.0.attempts.${date}.0.started`]:new Date(Date.now()-10000)}});
  const result=await v1Complete(started.body.attemptId,date,{auth:signed.body.token,profile:id});
  assert.equal(result.status,200); assert.equal(result.body.reward.id,'alpha');
  assert.equal((await repo.c('dateLedger').findOne({accountId:owner,profileId:id,date})).state,'consumed');
});
for (const source of ['v1','v2-untimed']) test(`${source} accepts the first date and settles inventory exactly once`, async()=>{
  let result;
  if(source==='v1'){const id=await v1Start();result=await v1Complete(id);assert.equal(result.body.reward.id,'alpha');assert.deepEqual((await v1Complete(id)).body,result.body);}
  else{const s=await v2Start();health=false;result=await v2Complete(s);assert.equal(result.body.timing.status,'untimed');assert.equal(result.body.collectible.status,'awarded');assert.deepEqual((await v2Complete(s)).body,result.body);}
  assert.equal(result.status,200);assert.deepEqual(await inventory(),{alpha:1});await invariants();
});
for(const first of ['v1','v2']) test(`${first} date winner is immutable across later cross-version attempts and catalog changes`,async()=>{
  let reward;
  if(first==='v1'){const id=await v1Start();reward=(await v1Complete(id)).body.reward;}
  else{const s=await v2Start();reward=(await v2Complete(s)).body.collectible.reward;}
  await RewardItem.deleteMany({});await RewardItem.create(item('replacement'));
  if(first==='v1'){const s=await v2Start(date,actor.profileId,'second-create');const r=await v2Complete(s);assert.equal(r.body.collectible.reward.id,reward.id);}
  else{const id=await v1Start();assert.equal((await v1Complete(id)).body.reward.id,reward.id);}
  assert.deepEqual(await inventory(),{alpha:1});assert.equal(await repo.c('grants').countDocuments(),1);await invariants();
});
for(const winner of ['v1','v2']) test(`concurrent authenticated v1/v2 completion with ${winner} committing first`,async()=>{
  const old=await v1Start(),s=await v2Start();
  const pause=barrier(winner==='v1'?'finish:read':'legacy:read');
  const losing=winner==='v1'?v2Complete(s):v1Complete(old);await pause.entered;
  const winning=await (winner==='v1'?v1Complete(old):v2Complete(s));assert.equal(winning.status,200);pause.release();
  const other=await losing;assert.equal(other.status,200,JSON.stringify(other.body));
  const a=winner==='v1'?winning.body.reward:winning.body.collectible.reward;
  const b=winner==='v1'?other.body.collectible.reward:other.body.reward;assert.equal(a.id,b.id);
  assert.deepEqual(await inventory(),{alpha:1});await invariants();
});
test('different dates contend on User inventory and cannot select the same previously unowned item',async()=>{
  await Maze.create({date:nextDate,seed:'synthetic',grid:[['S','E']],width:2,height:1});
  const old=await v1Start(nextDate),s=await v2Start();const pause=barrier('finish:read'),saving=v2Complete(s);await pause.entered;
  assert.equal((await v1Complete(old,nextDate)).body.reward.id,'alpha');pause.release();assert.equal((await saving).body.collectible.reward.id,'beta');
  assert.deepEqual(await inventory(),{alpha:1,beta:1});await invariants();await invariants(actor.profileId,nextDate);
});
test('an ID-less legacy attempt keeps its old wire shape and resolves one shared grant',async()=>{
  await v1Start();await User.collection.updateOne({_id:user._id},{$unset:{[`subProfiles.0.attempts.${date}.0.attemptId`]:''}});
  const r=await v1Complete();assert.equal(r.status,200);assert.equal(r.body.attemptId,undefined);assert.equal(r.body.reward.id,'alpha');
  assert.deepEqual((await v1Complete()).body,r.body);await invariants();
});
test('exhaustion is a permanent frozen null opportunity across later catalog expansion',async()=>{
  await RewardItem.deleteMany({});const id=await v1Start(),original=await v1Complete(id);
  assert.equal(original.body.reward,null);const grant=await repo.c('grants').findOne();assert.equal(grant.status,'exhausted');assert.equal(grant.collectionComplete,true);
  await RewardItem.create(item('new-after-exhaustion'));
  const s=await v2Start();const r=await v2Complete(s);assert.equal(r.body.collectible.status,'exhausted');assert.equal(r.body.collectible.collectionComplete,true);assert.equal(r.body.collectible.reward,null);
  assert.deepEqual((await v1Complete(id)).body,original.body);assert.deepEqual(await inventory(),{});await invariants();
});
test('owned retired items and quantities are preserved and selection is uniform over only unowned IDs',async()=>{
  await User.collection.updateOne({_id:user._id},{$set:{'subProfiles.0.rewards':{alpha:5,retired:7}}});
  const id=await v1Start(),r=await v1Complete(id);assert.equal(r.body.reward.id,'beta');
  assert.deepEqual(await inventory(),{alpha:5,retired:7,beta:1});assert.equal((await repo.c('grants').findOne()).selectionPolicy,'uniform-unowned-v1');
});
test('legacy siblings remain unknown by absence while a genuinely new sibling is eligible',async()=>{
  const legacyId=new mongoose.Types.ObjectId();const saved=await User.findById(user.id);saved.subProfiles.push({_id:legacyId,name:'Old sibling'});await saved.save();
  const id=await v1Start(date,legacyId.toString());const r=await v1Complete(id,date,{profile:legacyId.toString()});assert.equal(r.body.reward,null);
  assert.equal((await repo.c('dateLedger').findOne({profileId:legacyId.toString()})).state,'legacy-held');
  const s=await v2Start();assert.equal((await v2Complete(s)).body.collectible.status,'awarded');assert.equal(await repo.c('grants').countDocuments(),1);
});
test('explicit unknown/awarded/exhausted legacy history overrides even trusted profile birth evidence',async()=>{
  await repo.c('dateHistory').insertOne({...actor,date,state:'unknown',evidenceRef:'synthetic-review-hold'});
  const s=await v2Start();const r=await v2Complete(s);assert.equal(r.body.collectible.status,'review-required');assert.equal(r.body.progress.completed,true);
  assert.equal(await repo.c('grants').countDocuments(),0);assert.deepEqual(await inventory(),{});
});
test('positive new-date publication proof makes older profiles eligible without clearing old ambiguity',async()=>{
  const legacyId=new mongoose.Types.ObjectId();const saved=await User.findById(user.id);saved.subProfiles.push({_id:legacyId,name:'Legacy'});await saved.save();
  await bundle.lifecycle.publishNewMaze({date:nextDate,seed:'synthetic-new',grid:[['S','E']],width:2,height:1});
  const id=await v1Start(nextDate,legacyId.toString());assert.equal((await v1Complete(id,nextDate,{profile:legacyId.toString()})).body.reward.id,'alpha');
  const old=await v1Start(date,legacyId.toString());assert.equal((await v1Complete(old,date,{profile:legacyId.toString()})).body.reward,null);
  assert.equal((await repo.c('dateLedger').findOne({profileId:legacyId.toString(),date})).state,'legacy-held');
});
test('a future date or existing maze is never known-clear merely because the cutover ceiling is earlier',async()=>{
  const legacyId=new mongoose.Types.ObjectId();const saved=await User.findById(user.id);saved.subProfiles.push({_id:legacyId,name:'Legacy'});await saved.save();
  await Maze.create({date:nextDate,seed:'legacy-prepublished',grid:[['S','E']],width:2,height:1});
  await assert.rejects(bundle.lifecycle.publishNewMaze({date:nextDate,seed:'new',grid:[['S','E']],width:2,height:1}),{code:'MAZE_ALREADY_EXISTS'});
  await assert.rejects(bundle.lifecycle.publishNewMaze({date,seed:'old',grid:[['S','E']],width:2,height:1}),{code:'PUBLICATION_REQUIRES_NEW_DATE'});
  const id=await v1Start(nextDate,legacyId.toString());assert.equal((await v1Complete(id,nextDate,{profile:legacyId.toString()})).body.reward,null);
  assert.equal(await repo.c('grants').countDocuments(),0);
});
test('profile deletion/recreation uses a new server ID and preserves the old ledger/grant tombstones',async()=>{
  const id=await v1Start();await v1Complete(id);const old=actor.profileId;
  assert.equal((await req(`/users/subprofile/${old}`,undefined,{method:'DELETE'})).status,200);
  actor.profileId=await addProfile('Synthetic profile',{_id:old});assert.notEqual(actor.profileId,old);
  const next=await v1Start();assert.equal((await v1Complete(next)).body.reward.id,'alpha');
  assert.equal(await repo.c('grants').countDocuments(),2);assert.ok(await repo.c('profileOrigins').findOne({profileId:old}));
});
test('failed profile creation is atomic with its provenance and does not leave a phantom known-clear origin',async()=>{
  const before=await repo.c('profileOrigins').countDocuments();hook=async stage=>{if(stage==='profile:user')throw new Error('synthetic profile failure');};
  const r=await req('/users/subprofile',{name:'Rollback profile'},{profile:null});assert.equal(r.status,503);
  assert.equal((await User.findById(user.id)).subProfiles.length,1);assert.equal(await repo.c('profileOrigins').countDocuments(),before);
});
for(const stage of ['grant:record','grant:outbox','grant:inventory','legacy:result']) test(`failed ${stage} rolls claim, inventory, award and final result back together`,async()=>{
  const id=await v1Start();let once=false;hook=async current=>{if(current===stage&&!once){once=true;throw new Error('synthetic transaction rollback');}};
  assert.equal((await v1Complete(id)).status,503);assert.equal(await repo.c('grants').countDocuments(),0);assert.equal(await repo.c('dateLedger').countDocuments(),0);assert.equal(await repo.c('outbox').countDocuments(),0);assert.deepEqual(await inventory(),{});
  const r=await v1Complete(id);assert.equal(r.status,200);assert.equal(r.body.reward.id,'alpha');await invariants();
});
test('pending or malformed v2 routes create no grant or date opportunity',async()=>{
  const s=await v2Start();const r=await req(`/api/v2/sessions/${s.attemptId}/complete`,{completionKey:'complete-key',transcript:{...proof,commands:[]}},{ifMatch:s.revision});
  assert.equal(r.status,422);assert.equal(await repo.c('grants').countDocuments(),0);assert.equal(await repo.c('dateLedger').countDocuments(),0);
});
test('duplicate outbox delivery is idempotent and never re-applies inventory',async()=>{
  const id=await v1Start();await v1Complete(id);const event=await repo.c('outbox').findOne({type:'date-grant-settled'});
  const results=await Promise.all([bundle.rewards.acknowledge(event._id),bundle.rewards.acknowledge(event._id)]);
  assert.deepEqual(results[0],results[1]);assert.equal(await repo.c('deliveries').countDocuments(),1);assert.equal((await repo.c('outbox').findOne({_id:event._id})).state,'acked');assert.deepEqual(await inventory(),{alpha:1});
});
test('stale grant delivery revision is rejected without awarding or rolling a second item',async()=>{
  const id=await v1Start();await v1Complete(id);const event=await repo.c('outbox').findOne({type:'date-grant-settled'});
  await repo.c('outbox').updateOne({_id:event._id},{$inc:{ledgerRevision:1}});
  await assert.rejects(bundle.rewards.acknowledge(event._id),{code:'STALE_GRANT_EVENT'});assert.equal(await repo.c('deliveries').countDocuments(),0);assert.deepEqual(await inventory(),{alpha:1});
});
test('invalid User version fails closed for new grants while historical snapshots remain readable',async()=>{
  const id=await v1Start(),original=await v1Complete(id);await User.collection.updateOne({_id:user._id},{$unset:{__v:''}});
  assert.deepEqual((await v1Complete(id)).body,original.body);assert.deepEqual((await req('/off/maze/complete',{date,attemptId:id})).body,original.body);
});
test('unsafe default completion cannot award after compatible adoption, but old snapshots still replay',async()=>{
  const id=await v1Start(),original=await v1Complete(id);
  assert.deepEqual((await req('/off/maze/complete',{date,attemptId:id})).body,original.body);
  assert.equal((await req('/off/maze/start',{date})).body.code,'COMPATIBLE_WRITER_REQUIRED');
});
test('OFF lifecycle creates no provenance and unchanged legacy profiles retain per-attempt behavior',async()=>{
  const response=await req('/off/users/subprofile',{name:'Legacy off'},{profile:null});assert.equal(response.status,201);
  const profile=response.body.at(-1)._id;assert.equal(await repo.c('profileOrigins').countDocuments({profileId:profile}),0);
  for(let n=0;n<2;n++){
    const start=await req('/off/maze/start',{date},{profile});assert.equal(start.status,200);
    const saved=await User.findById(user.id),idx=saved.subProfiles.findIndex(p=>p.id===profile);
    await User.collection.updateOne({_id:user._id},{$set:{[`subProfiles.${idx}.attempts.${date}.${n}.started`]:new Date(Date.now()-10000)}});
    assert.equal((await req('/off/maze/complete',{date,attemptId:start.body.attemptId},{profile})).status,200);
  }
  assert.equal(Object.keys(await inventory(profile)).length,2);assert.equal(await repo.c('dateLedger').countDocuments(),0);
});

test('same-account siblings have independent inventories, provenance and date opportunities',async()=>{
  const sibling=await addProfile('Sibling');const a=await v1Start(),b=await v1Start(date,sibling);
  const results=await Promise.all([v1Complete(a),v1Complete(b,date,{profile:sibling})]);for(const result of results)assert.equal(result.status,200,JSON.stringify(result.body));
  assert.deepEqual(await inventory(),{alpha:1});assert.deepEqual(await inventory(sibling),{alpha:1});
  assert.equal(await repo.c('grants').countDocuments(),2);await invariants();await invariants(sibling);
});
test('missing/uncertified birth proof never blesses an otherwise empty profile as known-clear',async()=>{
  await repo.c('profileOrigins').updateOne({...actor},{$set:{epochId:'missing-certificate'}});
  const id=await v1Start();assert.equal((await v1Complete(id)).body.reward,null);
  assert.equal((await repo.c('dateLedger').findOne({...actor,date})).state,'legacy-held');assert.equal(await repo.c('grants').countDocuments(),0);
});
test('retired compatible epoch preserves trusted birth proof through a certified writer transition',async()=>{
  await repo.c('writerEpochs').updateOne({_id:epochId},{$set:{state:'retired'}});
  const second='synthetic-next-epoch';await repo.c('writerEpochs').insertOne({_id:second,version:'shared-date-v1',state:'active',revision:0,
    cutoverAt:Date.parse(`${nextDate}T00:00:00Z`),legacyDateCeiling:nextDate,evidenceRef:'synthetic-transition-evidence'});
  bundle.rewards.epochId=second;
  const id=await v1Start();assert.equal((await v1Complete(id)).body.reward.id,'alpha');await invariants();
});
test('writer pause fences a transaction already reading an accepted legacy completion',async()=>{
  const id=await v1Start(),pause=barrier('legacy:read'),saving=v1Complete(id);await pause.entered;
  await repo.c('writerEpochs').updateOne({_id:epochId},{$set:{state:'paused'},$inc:{revision:1}});pause.release();
  assert.equal((await saving).body.code,'WRITER_EPOCH_UNAVAILABLE');assert.deepEqual(await inventory(),{});assert.equal(await repo.c('grants').countDocuments(),0);
  assert.equal((await req('/users/subprofile',{name:'Blocked birth'},{profile:null})).status,503);
});
test('stale profile save cannot overwrite an inventory grant; a fresh edit preserves it',async()=>{
  const stale=await User.findById(user.id),id=await v1Start();await v1Complete(id);
  stale.subProfiles[0].name='Stale edit';await assert.rejects(stale.save(),mongoose.Error.VersionError);
  const edited=await req(`/users/subprofile/${actor.profileId}`,{name:'Fresh edit'},{method:'PUT'});assert.equal(edited.status,200);
  assert.deepEqual(await inventory(),{alpha:1});
});
test('invalid versions on an uncompleted legacy attempt cannot initialize versions or pay',async()=>{
  const id=await v1Start();await User.collection.updateOne({_id:user._id},{$unset:{__v:''}});
  const result=await v1Complete(id);assert.equal(result.body.code,'PROFILE_VERSION_REQUIRED');assert.equal(await repo.c('grants').countDocuments(),0);
  assert.equal((await User.collection.findOne({_id:user._id})).__v,undefined);
});
test('legacy unknown commit ACK recovers the majority-durable same award and snapshot after restart',async()=>{
  const id=await v1Start();repo.commitAttempts=1;const pause=barrier('legacy:read'),saving=v1Complete(id);await pause.entered;
  await rs.client.db('admin').command({configureFailPoint:'failCommand',mode:{times:2},data:{failCommands:['commitTransaction'],
    writeConcernError:{code:64,errmsg:'synthetic lost grant acknowledgment'},errorLabels:['UnknownTransactionCommitResult']}});
  pause.release();assert.equal((await saving).body.code,'COMMIT_UNKNOWN');await rs.failOff();
  const receipt=await until(()=>repo.c('legacyReceipts').findOne({accountId:user.id,profileId:actor.profileId},{readConcern:{level:'majority'}}));
  await rs.restart();await RewardItem.deleteMany({});
  const result=await v1Complete(id);assert.deepEqual(result.body,JSON.parse(JSON.stringify(receipt.response)));await invariants();
});
test('v2 unknown final grant ACK recovers immutable untimed award with no inventory reroll',async()=>{
  const s=await v2Start();health=false;repo.commitAttempts=1;const pause=barrier('finish:admitted'),saving=v2Complete(s);await pause.entered;
  await rs.client.db('admin').command({configureFailPoint:'failCommand',mode:{times:2},data:{failCommands:['commitTransaction'],
    writeConcernError:{code:64,errmsg:'synthetic v2 grant acknowledgment'},errorLabels:['UnknownTransactionCommitResult']}});
  pause.release();assert.equal((await saving).body.error,'COMMIT_UNKNOWN');await rs.failOff();
  const receipt=await until(()=>repo.c('results').findOne({attemptId:s.attemptId},{readConcern:{level:'majority'}}));
  await rs.restart();now-=1000;
  assert.deepEqual((await v2Complete(s)).body,JSON.parse(JSON.stringify(receipt.response)));assert.equal(receipt.response.timing.status,'untimed');await invariants();
});
test('closed commit connections keep pending legacy intent; restart safely completes its original receipt',async()=>{
  const id=await v1Start();repo.commitAttempts=1;const pause=barrier('legacy:read'),saving=v1Complete(id);await pause.entered;
  const original=await repo.c('legacyIntents').findOne();
  await rs.client.db('admin').command({configureFailPoint:'failCommand',mode:{times:2},data:{failCommands:['commitTransaction'],closeConnection:true}});
  pause.release();assert.equal((await saving).body.code,'COMMIT_UNKNOWN');await rs.failOff();
  await rs.restart();const result=await v1Complete(id);assert.equal(result.status,200);
  assert.equal((await repo.c('legacyReceipts').findOne()).receiptAt,original.receiptAt);await invariants();
});
test('primary stepdown retries the compatible legacy finalizer without a second grant',async()=>{
  const id=await v1Start(),pause=barrier('legacy:read'),saving=v1Complete(id);await pause.entered;
  const original=await repo.c('legacyIntents').findOne();await rs.stepDown();pause.release();
  assert.equal((await saving).status,200);assert.equal((await repo.c('legacyReceipts').findOne()).receiptAt,original.receiptAt);await invariants();
});
test('legacy resolver proves abort through shared intent/User fences before a fresh receipt generation',async()=>{
  const id=await v1Start(),pause=barrier('legacy:read'),saving=v1Complete(id);await pause.entered;
  const intent=await repo.c('legacyIntents').findOne();
  assert.equal((await bundle.legacy.recover(actor,intent._id)).outcome,'aborted');pause.release();assert.equal((await saving).status,409);
  const result=await v1Complete(id);assert.equal(result.status,200);
  const receipt=await repo.c('legacyReceipts').findOne();assert.equal(receipt.generation,2);assert.ok(receipt.receiptAt>=intent.receiptAt);await invariants();
});

async function childApp(crash, extra={}) {
  const child=fork(new URL('../tools/test-support/playable-process.mjs',import.meta.url),[],{stdio:['ignore','ignore','ignore','ipc']});children.push(child);
  const ready=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Synthetic compatible app startup timed out')),10000);
    child.once('message',m=>{clearTimeout(timer);resolve(m);});child.once('exit',()=>{clearTimeout(timer);reject(new Error('Synthetic compatible app exited'));});
    child.send({uri:rs.uri,secret,at:now,crash,compatible:true,epochId,...extra});
  });
  return {child,url:`http://127.0.0.1:${ready.port}`};
}
for(const source of ['v1','v2']) for(const stage of ['grant:record','grant:inventory',source==='v1'?'legacy:committed':'finish:committed']) {
  test(`${source} application SIGKILL at ${stage} plus MongoDB restart preserves exactly one inventory outcome`,async()=>{
    const id=source==='v1'?await v1Start():await v2Start();const child=await childApp(stage);
    await assert.rejects(source==='v1'?v1Complete(id,date,{url:child.url}):v2Complete(id,{url:child.url}));
    const original=source==='v1'?await repo.c('legacyIntents').findOne():await repo.c('intents').findOne();
    await rs.restart();const recovered=await childApp();
    const response=await (source==='v1'?v1Complete(id,date,{url:recovered.url}):v2Complete(id,{url:recovered.url}));
    assert.equal(response.status,200,JSON.stringify(response.body));
    const receipt=source==='v1'?await repo.c('legacyReceipts').findOne():await repo.c('results').findOne();
    assert.equal(source==='v1'?receipt.receiptAt:receipt.receipt.at,source==='v1'?original.receiptAt:original.receipt.at);
    assert.deepEqual(await inventory(),{alpha:1});await invariants();
  });
}
test('delivery SIGKILL after acknowledgment commit deduplicates after restart without touching inventory',async()=>{
  const id=await v1Start();await v1Complete(id);const event=await repo.c('outbox').findOne({type:'date-grant-settled'});
  const child=fork(new URL('../tools/test-support/playable-process.mjs',import.meta.url),[],{stdio:['ignore','ignore','ignore','ipc']});children.push(child);
  const died=new Promise(resolve=>child.once('exit',(code,signal)=>resolve(signal)));
  child.send({uri:rs.uri,secret,at:now,crash:'delivery:committed',compatible:true,epochId,ackEventId:event._id});
  assert.equal(await died,'SIGKILL');await rs.restart();
  await bundle.rewards.acknowledge(event._id);assert.equal(await repo.c('deliveries').countDocuments(),1);assert.deepEqual(await inventory(),{alpha:1});await invariants();
});
test('independent compatible application processes race v1/v2 with one shared immutable award',async()=>{
  const old=await v1Start(),s=await v2Start();const a=await childApp(),b=await childApp();
  const [v1,v2]=await Promise.all([v1Complete(old,date,{url:a.url}),v2Complete(s,{url:b.url})]);
  assert.equal(v1.status,200,JSON.stringify(v1.body));assert.equal(v2.status,200,JSON.stringify(v2.body));
  assert.equal(v1.body.reward.id,v2.body.collectible.reward.id);assert.deepEqual(await inventory(),{alpha:1});
  await rs.restart();assert.deepEqual((await v1Complete(old)).body,v1.body);assert.deepEqual((await v2Complete(s)).body,v2.body);await invariants();
});
test('catalog snapshot retains legacy model defaults without exposing database metadata in v2',async()=>{
  await RewardItem.collection.updateOne({id:'alpha'},{$unset:{marketValue:''}});
  const id=await v1Start();const r=await v1Complete(id);assert.equal(r.body.reward.marketValue,0);assert.ok(r.body.reward._id);
  const s=await v2Start();const newer=await v2Complete(s);assert.equal(newer.body.collectible.reward.marketValue,0);assert.equal(newer.body.collectible.reward._id,undefined);
});
test('too-fast legacy submissions and foreign ownership never obtain an accepted-date claim',async()=>{
  const started=await req('/maze/start',{date});assert.equal(started.status,200);
  assert.equal((await v1Complete(started.body.attemptId)).body.code,'TOO_FAST');
  const other=await User.create({email:'foreign-synthetic@example.invalid',password:'unused',subProfiles:[{name:'Foreign'}]});
  const foreign=jwt.sign({id:other.id},secret);
  assert.equal((await v1Complete(started.body.attemptId,date,{auth:foreign,profile:actor.profileId})).status,404);
  assert.equal(await repo.c('grants').countDocuments(),0);assert.equal(await repo.c('dateLedger').countDocuments(),0);
});
test('concurrent profile deletion fences legacy acceptance and leaves no grant or claim',async()=>{
  const id=await v1Start(),pause=barrier('legacy:read'),saving=v1Complete(id);await pause.entered;
  assert.equal((await req(`/users/subprofile/${actor.profileId}`,undefined,{method:'DELETE'})).status,200);
  pause.release();assert.equal((await saving).status,404);assert.equal(await repo.c('grants').countDocuments(),0);assert.equal(await repo.c('dateLedger').countDocuments(),0);
});
test('UUID and ID-less requests for the same legacy attempt share one canonical durable intent',async()=>{
  const id=await v1Start(),pause=barrier('legacy:read'),first=v1Complete();await pause.entered;
  const winner=await v1Complete(id);assert.equal(winner.status,200);pause.release();assert.deepEqual((await first).body,winner.body);
  assert.equal(await repo.c('legacyIntents').countDocuments(),1);const intent=await repo.c('legacyIntents').findOne();
  assert.equal(intent.state,'completed');assert.deepEqual(JSON.parse(JSON.stringify(await bundle.legacy.recover(actor,intent._id))),winner.body);await invariants();
});
test('malformed retired certification cannot confer known-clear birth provenance in a new active epoch',async()=>{
  await repo.c('writerEpochs').updateOne({_id:epochId},{$set:{state:'retired',evidenceRef:42}});
  const next='synthetic-certified-next';await repo.c('writerEpochs').insertOne({_id:next,version:'shared-date-v1',state:'active',revision:0,
    cutoverAt:Date.parse(`${nextDate}T00:00:00Z`),legacyDateCeiling:nextDate,evidenceRef:'synthetic-next-audit'});
  bundle.rewards.epochId=next;
  const id=await v1Start();assert.equal((await v1Complete(id)).body.reward,null);assert.equal((await repo.c('dateLedger').findOne()).state,'legacy-held');
  assert.equal(await repo.c('grants').countDocuments(),0);
});

// Malformed rows are inserted through the native driver: model hydration must
// never cast, default or hide the stored counterexamples being asserted here.
async function rawProfile() {
  return (await User.collection.findOne({ _id: user._id })).subProfiles.find(p => p._id.toString() === actor.profileId);
}
async function completion(source) {
  const id = source === 'v1' ? await v1Start() : await v2Start();
  return { id, send: options => source === 'v1' ? v1Complete(id, date, options) : v2Complete(id, options),
    intent: () => repo.c(source === 'v1' ? 'legacyIntents' : 'intents').findOne(),
    receipt: () => repo.c(source === 'v1' ? 'legacyReceipts' : 'results').findOne() };
}
async function rejectedSettlement(op, code, expectedInventory) {
  const before = await rawProfile(), catalog = await RewardItem.collection.find({}).toArray();
  const version = (await User.collection.findOne({ _id: user._id })).__v, response = await op.send();
  assert.equal(response.status, 503, JSON.stringify(response.body));
  assert.equal(response.body.code ?? response.body.error, code);
  for (const name of ['dateHistory', 'dateLedger', 'grants', 'outbox', 'progress', 'results', 'legacyReceipts', 'deliveries']) {
    assert.equal(await repo.c(name).countDocuments(), 0, `No final effects in ${name}`);
  }
  const saved = await rawProfile();
  assert.deepEqual(saved.rewards, expectedInventory);
  assert.deepEqual(saved, before, 'No embedded attempt, inventory or progress mutation');
  assert.equal((await User.collection.findOne({ _id: user._id })).__v, version);
  assert.deepEqual(await RewardItem.collection.find({}).toArray(), catalog, 'No automatic catalog repair');
  const intent = await op.intent(); assert.equal(intent.state, 'pending');
  const session = await repo.c('sessions').findOne();
  if (session) {
    assert.equal(session.state, 'STARTED'); assert.equal(session.resultId, undefined);
    assert.equal((await repo.c('slots').findOne()).attemptId, session._id);
    assert.equal((await repo.c('keys').findOne({ operation: 'complete' })).state, 'pending');
  }
  return intent;
}
async function repairedSettlement(op, original, expectedInventory, expectedReward = 'alpha') {
  const response = await op.send(); assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal((response.body.collectible?.reward ?? response.body.reward)?.id ?? null, expectedReward);
  assert.deepEqual((await rawProfile()).rewards, expectedInventory);
  const receipt = await op.receipt();
  assert.equal(receipt.receiptAt ?? receipt.receipt.at, original.receiptAt ?? original.receipt.at);
  assert.equal((await op.intent()).generation, original.generation);
  assert.equal(await repo.c('grants').countDocuments(), 1); await invariants();
  return response;
}
for (const source of ['v1', 'v2']) {
  test(`${source} QA incomplete catalog counterexample rolls back and repaired same-operation award survives restart`, async () => {
    const op = await completion(source); await RewardItem.deleteMany({});
    await RewardItem.collection.insertOne({ id: 'malformed' });
    const original = await rejectedSettlement(op, 'CATALOG_REVIEW_REQUIRED', {});
    await RewardItem.collection.updateOne({ id: 'malformed' }, { $set: item('malformed') });
    const winner = await repairedSettlement(op, original, { malformed: 1 }, 'malformed');
    await rs.restart(); const app = await childApp();
    // Frozen receipts remain readable even after the catalog regresses again.
    await RewardItem.collection.updateOne({ id: 'malformed' }, { $unset: { name: '' } });
    assert.deepEqual((await op.send({ url: app.url })).body, winner.body);
    const later = source === 'v1' ? await v2Start() : await v1Start();
    const repeated = source === 'v1' ? await v2Complete(later, { url: app.url }) : await v1Complete(later, date, { url: app.url });
    assert.equal(repeated.status, 200); assert.equal((repeated.body.collectible?.reward ?? repeated.body.reward).id, 'malformed');
    assert.deepEqual((await rawProfile()).rewards, { malformed: 1 }); await invariants();
  });
  test(`${source} QA nested inventory counterexample rolls back and repaired same-operation award survives restart`, async () => {
    const op = await completion(source), invalid = { retired: { invalid: true } };
    await User.collection.updateOne({ _id: user._id }, { $set: { 'subProfiles.0.rewards': invalid } });
    const original = await rejectedSettlement(op, 'INVENTORY_REVIEW_REQUIRED', invalid);
    await User.collection.updateOne({ _id: user._id }, { $set: { 'subProfiles.0.rewards': { retired: 7 } } });
    const winner = await repairedSettlement(op, original, { retired: 7, alpha: 1 });
    await rs.restart(); const app = await childApp();
    assert.deepEqual((await op.send({ url: app.url })).body, winner.body);
    const later = source === 'v1' ? await v2Start() : await v1Start();
    const repeated = source === 'v1' ? await v2Complete(later, { url: app.url }) : await v1Complete(later, date, { url: app.url });
    assert.equal(repeated.status, 200); assert.equal((repeated.body.collectible?.reward ?? repeated.body.reward).id, 'alpha');
    assert.deepEqual((await rawProfile()).rewards, { retired: 7, alpha: 1 }); await invariants();
  });

  for (const field of ['name', 'image', 'description', 'category', 'rarity']) {
    test(`${source} catalog required ${field} rejects missing empty null and coercible types before retry`, async () => {
      const op = await completion(source); let original;
      for (const value of [undefined, '', null, 42, ['common'], { invalid: true }]) {
        const row = item('alpha'); if (value === undefined) delete row[field]; else row[field] = value;
        await RewardItem.collection.replaceOne({ id: 'alpha' }, row);
        original = await rejectedSettlement(op, 'CATALOG_REVIEW_REQUIRED', {});
      }
      await RewardItem.collection.replaceOne({ id: 'alpha' }, item('alpha'));
      await repairedSettlement(op, original, { alpha: 1 });
    });
  }
  test(`${source} catalog enforces schema enums and finite numeric market values without coercion`, async () => {
    const op = await completion(source); let original;
    const patches = [{ category: 'unknown' }, { rarity: 'unknown' },
      ...['12', null, NaN, Infinity, -Infinity, [], {}, true].map(marketValue => ({ marketValue }))];
    for (const patch of patches) {
      await RewardItem.collection.replaceOne({ id: 'alpha' }, { ...item('alpha'), ...patch });
      original = await rejectedSettlement(op, 'CATALOG_REVIEW_REQUIRED', {});
    }
    await RewardItem.collection.replaceOne({ id: 'alpha' }, { ...item('alpha'), marketValue: 12.5 });
    const valid = await repairedSettlement(op, original, { alpha: 1 });
    assert.equal((valid.body.collectible?.reward ?? valid.body.reward).marketValue, 12.5);
  });
  test(`${source} validates unsafe catalog IDs and every candidate including owned or unselected records`, async () => {
    const op = await completion(source); let original;
    await User.collection.updateOne({ _id: user._id }, { $set: { 'subProfiles.0.rewards': { retired: 7 } } });
    for (const id of [undefined, 42, '', 'bad.path', '$bad', '__proto__', 'constructor', 'prototype', 'x'.repeat(129), 'retired', 'z-unselected']) {
      const row = { id }; if (id === undefined) delete row.id;
      await RewardItem.collection.insertOne(row);
      original = await rejectedSettlement(op, 'CATALOG_REVIEW_REQUIRED', { retired: 7 });
      await RewardItem.collection.deleteOne({ _id: row._id });
    }
    await repairedSettlement(op, original, { retired: 7, alpha: 1 });
  });
  test(`${source} rejects raw inventory quantities without casting or normalizing and preserves valid multiples`, async () => {
    const op = await completion(source); let original;
    for (const value of [{ invalid: true }, [], '7', null, true, NaN, Infinity, -Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const rewards = { retired: value };
      await User.collection.updateOne({ _id: user._id }, { $set: { 'subProfiles.0.rewards': rewards } });
      original = await rejectedSettlement(op, 'INVENTORY_REVIEW_REQUIRED', rewards);
    }
    // Historical safe map keys need not match the narrower current catalog-ID
    // grammar. Zero is retained as an owned entry, matching legacy key presence.
    const preserved = { alpha: 5, retired: Number.MAX_SAFE_INTEGER, zero: 0, 'Retired item 🧭': 7 };
    await User.collection.updateOne({ _id: user._id }, { $set: { 'subProfiles.0.rewards': preserved } });
    await repairedSettlement(op, original, { ...preserved, beta: 1 }, 'beta');
  });
  test(`${source} rejects unsafe raw inventory keys without losing retired entries or consuming the date`, async () => {
    const op = await completion(source); let original;
    for (const key of ['bad.path', '$bad', '__proto__', 'constructor', 'prototype', '']) {
      const rewards = Object.fromEntries([['retired', 7], [key, 1]]);
      await User.collection.updateOne({ _id: user._id }, { $set: { 'subProfiles.0.rewards': rewards } });
      original = await rejectedSettlement(op, 'INVENTORY_REVIEW_REQUIRED', rewards);
    }
    await User.collection.updateOne({ _id: user._id }, { $set: { 'subProfiles.0.rewards': { retired: 7 } } });
    await repairedSettlement(op, original, { retired: 7, alpha: 1 });
  });
  test(`${source} rejects malformed inventory containers even with an empty catalog then safely exhausts after repair`, async () => {
    const op = await completion(source); let original; await RewardItem.deleteMany({});
    for (const rewards of [null, [], 'invalid', 7, new Date(0)]) {
      await User.collection.updateOne({ _id: user._id }, { $set: { 'subProfiles.0.rewards': rewards } });
      original = await rejectedSettlement(op, 'INVENTORY_REVIEW_REQUIRED', rewards);
    }
    await User.collection.updateOne({ _id: user._id }, { $set: { 'subProfiles.0.rewards': { retired: 7 } } });
    const winner = await repairedSettlement(op, original, { retired: 7 }, null);
    assert.equal((await repo.c('grants').findOne()).status, 'exhausted');
    await rs.restart(); await RewardItem.create(item('new-after-repair'));
    assert.deepEqual((await op.send()).body, winner.body);
    const later = source === 'v1' ? await v2Start() : await v1Start();
    const repeated = source === 'v1' ? await v2Complete(later) : await v1Complete(later);
    assert.equal(repeated.status, 200); assert.equal((await repo.c('grants').findOne()).status, 'exhausted');
    assert.equal(repeated.body.collectible?.reward ?? repeated.body.reward ?? null, null);
    assert.deepEqual((await rawProfile()).rewards, { retired: 7 }); await invariants();
  });
  test(`${source} preserves legitimate missing inventory and market-value defaults without repairing catalog rows`, async () => {
    const op = await completion(source);
    await User.collection.updateOne({ _id: user._id }, { $unset: { 'subProfiles.0.rewards': '' } });
    await RewardItem.collection.updateOne({ id: 'alpha' }, { $unset: { marketValue: '' } });
    const response = await op.send(); assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal((response.body.collectible?.reward ?? response.body.reward).marketValue, 0);
    assert.equal(Object.hasOwn(await RewardItem.collection.findOne({ id: 'alpha' }), 'marketValue'), false);
    assert.deepEqual((await rawProfile()).rewards, { alpha: 1 }); await invariants();
  });
}
