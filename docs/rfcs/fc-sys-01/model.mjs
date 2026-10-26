// RFC v0.3 offline oracle. All mutations are SERIAL schedules, not MongoDB proof.
import {createHash} from 'node:crypto';
import {compileGrid, normalizeTranscript, replayTranscript, ROUTE_POLICY, FIXTURE_ABILITIES} from './transcript.mjs';
const freeze = value => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const copy = value => structuredClone(value);
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
export const payloadHash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const tuple = (...parts) => JSON.stringify(parts);
const open = s => ['PREPARED', 'STARTED'].includes(s.state);
const identity = actor => tuple(actor.accountId, actor.profileId);
const compare = (a, b) => {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
};
export const fixtureClock = () => ({epoch:'fixture-epoch', healthy:true, uncertaintyMs:1, evidenceId:'fixture-monitor'});

export class Sessions {
  constructor({prepareMs=300000, playMs=7200000, maxUncertaintyMs=10, grid=['SE']}={}) {
    // TTL values and health bounds are fixture proposals, not approved production values.
    this.policy = freeze({prepareMs, playMs, maxUncertaintyMs});
    compileGrid(grid); this.grid=freeze(copy(grid));
    this.now = 0;
    this.sessions = new Map(); this.keys = new Map(); this.slots = new Map();
    this.completionKeys = new Map(); this.intentKeys = new Map(); this.sessionKeys = new Map(); this.requests = new WeakSet();
    this.guardFailures = new WeakMap(); this.pendingCommits = new Map(); this.commitObservations = [];
    this.history = new Map(); this.entitlements = new Map(); this.events = [];
    this.sourceRevision = 0; this.acceptanceSequence = 0; this.next = 0;
    this.best = []; this.boardRevision = 0;
  }
  tick(ms) { this.now += ms; }
  error(code) {
    const status=['COMMIT_UNKNOWN','CLOCK_UNAVAILABLE'].includes(code)?503:undefined;
    throw Object.assign(new Error(code),{code,status,retrySameOperation:status===503,
      commitOutcome:code==='COMMIT_UNKNOWN'?'unknown':['CLOCK_UNAVAILABLE','BEFORE_COMMIT'].includes(code)?'aborted':undefined});
  }
  owned(actor, id) {
    const s = this.sessions.get(id);
    if (!s || identity(s.actor) !== identity(actor)) this.error('NOT_FOUND');
    return s;
  }
  release(s) {
    // A stale cleanup for A must never release successor B's slot.
    if (this.slots.get(identity(s.actor)) === s.id) this.slots.delete(identity(s.actor));
  }
  effective(s) {
    if (open(s) && this.now >= s.deadline) {
      s.state = 'EXPIRED'; s.revision++; this.release(s);
    }
    return s;
  }
  status(actor, id) { return this.effective(this.owned(actor, id)); }
  revision(s, expected) { if (s.revision !== expected) this.error('REVISION'); }
  create(actor, key, {date='fixture-date', abilityIds=[], competition='fixture-equal-window'}={}) {
    const abilities = [...abilityIds].sort();
    if (new Set(abilities).size !== abilities.length) this.error('ABILITY_DUPLICATE');
    // These are trusted synthetic grants. Production must resolve ownership/config server-side.
    const manifest = freeze({date, abilityIds:abilities, competitionVersion:competition,
      runClass:abilities.length ? 'assisted' : 'standard', ...ROUTE_POLICY,
      scoringMethod:'playable-receipt-v2'});
    if(abilities.some(id=>!FIXTURE_ABILITIES.includes(id)))this.error('POLICY_UNSUPPORTED');
    const hash = payloadHash({operation:'create', profileId:actor.profileId, date, abilityIds:abilities});
    const scope = tuple(actor.accountId, key);
    if (this.keys.has(scope)) {
      const s = this.sessions.get(this.keys.get(scope));
      if (s.createHash !== hash) this.error('KEY_CONFLICT');
      return this.effective(s);
    }
    const active = this.sessions.get(this.slots.get(identity(actor)));
    if (active && open(this.effective(active))) this.error('ACTIVE_SESSION');
    const s = {id:`session-${++this.next}`, actor:freeze(copy(actor)), manifest,
      createHash:hash, state:'PREPARED', revision:1, deadline:this.now+this.policy.prepareMs,
      nonce:`synthetic-${this.next}`, gridHash:payloadHash(this.grid)};
    this.sessions.set(s.id, s); this.keys.set(scope, s.id); this.slots.set(identity(actor), s.id);
    return s;
  }
  sessionBinding(actor,id,operation,key,payload) {
    const scope=tuple(actor.accountId,id,operation,key), hash=payloadHash({profileId:actor.profileId,...payload});
    const prior=this.sessionKeys.get(scope);
    if(prior && prior.hash!==hash)this.error('KEY_CONFLICT');
    return {scope,hash,prior};
  }
  ready(actor, id, {key='ready', nonce, gridHash, rulesVersion, ifMatch, clock=fixtureClock()}={}) {
    const s = this.effective(this.owned(actor, id));
    gridHash ??= s.gridHash; rulesVersion ??= s.manifest.rulesVersion;
    const binding=this.sessionBinding(actor,id,'ready',key,{nonce,gridHash,rulesVersion});
    // Ready/abandon keys are session-scoped, not account-wide.
    if (binding.prior) return s;
    if (s.state !== 'PREPARED') this.error(s.state);
    this.revision(s, ifMatch);
    if (nonce !== s.nonce || gridHash !== s.gridHash || rulesVersion !== s.manifest.rulesVersion) this.error('READY_BINDING');
    s.startedAt = this.now; s.startClock = freeze(copy(clock));
    s.state = 'STARTED'; s.deadline = this.now+this.policy.playMs; s.revision++;
    this.sessionKeys.set(binding.scope,{hash:binding.hash});
    return s;
  }
  completionBinding(actor, id, key, transcriptHash) {
    const scope = tuple(actor.accountId, key), hash = payloadHash({operation:'complete', profileId:actor.profileId, attemptId:id, transcriptHash});
    const prior = this.completionKeys.get(scope)||this.intentKeys.get(scope);
    if (prior && prior.hash !== hash) this.error('KEY_CONFLICT');
    return {scope, hash};
  }
  captureComplete(actor, id, {key='complete', ifMatch, clock=fixtureClock(), transcript, ...extra}={}) {
    const s = this.owned(actor, id);
    if (Object.keys(extra).length) this.error('PAYLOAD');
    if(this.pendingCommits.has(id)&&!s.result)this.error('COMMIT_UNKNOWN');
    // Capture after bounded schema normalization/binding, before deterministic route replay.
    const {normalized,hash}=normalizeTranscript(transcript);
    this.completionBinding(actor,id,key,hash);
    const receivedAt=this.now;
    const validation=replayTranscript(this.grid,s.manifest,normalized,{supportedAbilities:FIXTURE_ABILITIES});
    if(s.result&&s.result.transcriptHash!==validation.transcriptHash)this.error('KEY_CONFLICT');
    const request = freeze({actor:copy(actor), id, key, ifMatch, receivedAt, clock:copy(clock), validation});
    this.requests.add(request);
    return request;
  }
  commitComplete(request, {guardAt=this.now, committedAt=this.now, commit=true, ackLost=false}={}) {
    // committedAt is a POST-COMMIT observation, not part of the result transaction.
    if (!this.requests.has(request)) this.error('RECEIPT_BINDING');
    const {actor, id, key, ifMatch, receivedAt, clock, validation} = request;
    const s = this.owned(actor, id), binding = this.completionBinding(actor,id,key,validation.transcriptHash);
    if (s.result) {
      if(s.result.transcriptHash!==validation.transcriptHash)this.error('KEY_CONFLICT');
      this.pendingCommits.delete(id);
      this.completionKeys.set(binding.scope, {...binding, resultId:s.result.id});
      return s.result; // Durable result precedence includes backward clocks/unknown ACK.
    }
    if(this.pendingCommits.has(id))this.error('COMMIT_UNKNOWN');
    if (s.state !== 'STARTED') this.error(s.state);
    if (guardAt < receivedAt) {
      const failures=this.guardFailures.get(request)||[];failures.push({receivedAt,guardAt});
      this.guardFailures.set(request,failures);this.error('CLOCK_UNAVAILABLE');
    }
    if (receivedAt >= s.deadline || guardAt >= s.deadline) {
      this.effective(s); this.error('EXPIRED');
    }
    this.revision(s, ifMatch);
    this.intentKeys.set(binding.scope,{...binding}); // Models a durable intake hash binding only.
    if (!commit) {
      if(ackLost){this.pendingCommits.set(id,request);this.error('COMMIT_UNKNOWN');}
      this.error('BEFORE_COMMIT');
    }
    const elapsedMs = receivedAt-s.startedAt;
    const evidence = freeze({start:s.startClock, receipt:copy(clock),
      guardReversals:copy(this.guardFailures.get(request)||[]),maxUncertaintyMs:this.policy.maxUncertaintyMs});
    const irreparable = elapsedMs < 0 || !this.clockPresent(evidence.start) || !this.clockPresent(evidence.receipt)
      || evidence.start.epoch !== evidence.receipt.epoch;
    const reviewable = !irreparable && (evidence.guardReversals.length>0
      || [evidence.start, evidence.receipt].some(c => !c.healthy || c.uncertaintyMs > this.policy.maxUncertaintyMs));
    s.result = freeze({id:`result-${s.id}`, attemptId:s.id, startedAt:s.startedAt, receivedAt, guardAt, elapsedMs,
      transcriptHash:validation.transcriptHash,commandCount:validation.commandCount,routeValidated:true,
      integrityTier:s.manifest.integrityTier, validationPolicyVersion:s.manifest.validationPolicyVersion,
      clockEvidence:evidence, clockDisposition:irreparable ? 'irreparable' : reviewable ? 'review-required' : 'healthy',
      entitlementStatus:'unresolved-at-receipt'});
    s.decision = irreparable || reviewable ? 'quarantined' : 'pending'; s.decisionRevision = 0; s.audit = [];
    s.state = 'COMPLETED'; s.revision++; this.release(s);
    this.completionKeys.set(binding.scope, {...binding, resultId:s.result.id});
    this.sourceRevision++; this.events.push(freeze({type:'receipt', id:s.id, revision:0}));
    this.commitObservations.push(freeze({resultId:s.result.id,observedAt:committedAt,clockReversed:committedAt<guardAt}));
    if(ackLost){this.pendingCommits.set(id,request);this.error('COMMIT_UNKNOWN');}
    return s.result;
  }
  resolveCommit(actor,id,{provedAborted=false}={}) {
    // Synthetic proof input only; a missing DB read is NOT proof of abort.
    const s=this.owned(actor,id);
    if(s.result){this.pendingCommits.delete(id);return s.result;}
    if(!this.pendingCommits.has(id))this.error('NO_UNCERTAIN_OPERATION');
    if(!provedAborted)this.error('COMMIT_UNKNOWN');
    s.revision++; // Resolver fence prevents an older unresolved transaction from committing later.
    this.pendingCommits.delete(id);return {outcome:'aborted',retrySameOperation:true};
  }
  complete(actor, id, options={}) { return this.commitComplete(this.captureComplete(actor, id, options)); }
  clockPresent(c) {
    return c && typeof c.epoch === 'string' && c.epoch.length > 0 && typeof c.healthy === 'boolean'
      && Number.isFinite(c.uncertaintyMs) && c.uncertaintyMs >= 0 && typeof c.evidenceId === 'string' && c.evidenceId.length > 0;
  }
  abandon(actor, id, {key='abandon', reason='user-choice', ifMatch}={}) {
    const s = this.effective(this.owned(actor, id));
    if(!['user-choice','restart','change-grants'].includes(reason))this.error('PAYLOAD');
    const binding=this.sessionBinding(actor,id,'abandon',key,{reason});
    if(binding.prior)return s;
    if(this.pendingCommits.has(id)&&!s.result)this.error('COMMIT_UNKNOWN');
    if (!open(s)) this.error(s.state);
    this.revision(s, ifMatch);
    s.state = 'ABANDONED'; s.revision++; this.release(s);
    this.sessionKeys.set(binding.scope,{hash:binding.hash});return s;
  }
  legacy(actor, date, status, snapshot={}) {
    if (!['clear', 'awarded', 'exhausted', 'unknown'].includes(status)) this.error('HISTORY');
    const k = tuple(identity(actor), date);
    if (this.history.has(k) || this.entitlements.has(k)) this.error('HISTORY_LOCKED');
    this.history.set(k, freeze({status, snapshot:copy(snapshot)}));
  }
  entitlement(actor, date) {
    const k = tuple(identity(actor), date);
    return this.entitlements.get(k) || freeze({state:this.history.get(k)?.status === 'clear' ? 'available' : 'legacy-held', revision:0});
  }
  reconcile(s) {
    const k = tuple(identity(s.actor), s.manifest.date), previous = this.entitlements.get(k);
    if (previous?.state === 'consumed' || previous?.state === 'exhausted') return;
    const history = this.history.get(k)?.status ?? 'unknown';
    const candidates = [...this.sessions.values()].filter(x => identity(x.actor) === identity(s.actor)
      && x.manifest.date === s.manifest.date && x.decision === 'accepted');
    candidates.sort((a,b) => a.acceptanceSequence-b.acceptanceSequence);
    const winner = candidates[0];
    const revision = (previous?.revision ?? 0)+1;
    const next = history === 'clear'
      ? {state:winner ? 'eligible' : 'available', resultId:winner?.result.id, revision}
      : {state:'legacy-held', history, revision};
    this.entitlements.set(k, freeze(next));
    if (next.state === 'eligible') this.events.push(freeze({type:'entitlement', ...next, key:k}));
  }
  decide(actor, id, decision, {authority='validator', expectedRevision, reason='fixture-policy-check', repair}={}) {
    const s = this.owned(actor, id);
    if (!s.result) this.error('NO_RESULT');
    if (!['validator', 'reviewer'].includes(authority)) this.error('AUTHORITY');
    if (!['accepted', 'quarantined', 'rejected'].includes(decision)) this.error('DECISION');
    if (expectedRevision !== s.decisionRevision) this.error('ADJUDICATION_REVISION');
    if (!reason) this.error('REASON');
    if (decision === 'accepted') {
      if(!s.result.routeValidated)this.error('ROUTE_NOT_VALIDATED');
      if (s.result.clockDisposition === 'irreparable') this.error('CLOCK_IRREPARABLE');
      if (s.result.clockDisposition === 'review-required' && !(authority === 'reviewer' && repair?.independentlyVerified === true
        && repair.evidenceId && repair.epoch === s.startClock.epoch && Number.isFinite(repair.uncertaintyMs)
        && repair.uncertaintyMs >= 0 && repair.uncertaintyMs <= this.policy.maxUncertaintyMs)) this.error('CLOCK_REVIEW_REQUIRED');
      if (s.decision !== 'accepted') s.acceptanceSequence = ++this.acceptanceSequence;
    }
    s.decision = decision; s.decisionRevision++;
    s.audit.push(freeze({decision, revision:s.decisionRevision, adjudicatedAt:this.now, authority, reason, repair:repair ? copy(repair) : null}));
    this.sourceRevision++; this.reconcile(s);
    const event = freeze({type:'adjudication', id, revision:s.decisionRevision}); this.events.push(event); return event;
  }
  consumeOpportunity(actor, date, token, outcome='consumed') {
    // Models only a fenced ledger terminal state. NO catalog, random draw, or inventory.
    const k = tuple(identity(actor), date), current = this.entitlement(actor, date);
    if (['consumed', 'exhausted'].includes(current.state)) return current;
    if (!['consumed', 'exhausted'].includes(outcome)) this.error('OUTCOME');
    if (current.state !== 'eligible' || current.revision !== token.revision || current.resultId !== token.resultId) this.error('STALE_ENTITLEMENT');
    const s = [...this.sessions.values()].find(x => x.result?.id === current.resultId);
    if (s?.decision !== 'accepted') this.error('NOT_ACCEPTED');
    const terminal = freeze({...current, state:outcome, revision:current.revision+1});
    this.entitlements.set(k, terminal); return terminal;
  }
  computeProjection() {
    // Internal oracle rows include private evidence; public API serialization is unmodeled.
    const best = new Map();
    for (const s of this.sessions.values()) if (s.decision === 'accepted') {
      const k = tuple(identity(s.actor), s.manifest.date, s.manifest.scoringMethod, s.manifest.competitionVersion, s.manifest.runClass);
      const row = {profile:identity(s.actor), date:s.manifest.date, ...s.manifest, ...s.result};
      const previous = best.get(k);
      const rank = r => [r.elapsedMs, r.receivedAt, r.id];
      if (!previous || compare(rank(row), rank(previous)) < 0) best.set(k, row);
    }
    return [...best.values()].sort((a,b) => compare([a.elapsedMs,a.receivedAt,a.id], [b.elapsedMs,b.receivedAt,b.id]));
  }
  projectionSnapshot() { return freeze({sourceRevision:this.sourceRevision, rows:copy(this.computeProjection())}); }
  publishProjection(snapshot) {
    if (snapshot.sourceRevision !== this.sourceRevision) this.error('STALE_PROJECTION');
    this.best = copy(snapshot.rows); this.boardRevision++; return this.best;
  }
  project() { return this.publishProjection(this.projectionSnapshot()); }
}
