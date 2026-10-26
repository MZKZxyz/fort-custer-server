// Offline design model only: serialized commit boundaries, not database code.
export class Sessions {
  constructor() { this.now=0; this.sessions=new Map(); this.keys=new Map(); this.slots=new Map(); this.claims=new Set(); this.best=new Map(); this.events=[]; this.next=0; }
  tick(ms) { this.now+=ms; }
  error(code) { throw new Error(code); }
  owned(actor,id) { const s=this.sessions.get(id); if(!s||s.actor!==actor)this.error('NOT_FOUND'); return s; }
  effective(s) {
    if(['PREPARED','STARTED'].includes(s.state)&&this.now>=s.deadline){s.state='EXPIRED';s.revision++;if(this.slots.get(s.actor)===s.id)this.slots.delete(s.actor);}
    return s;
  }
  create(actor,key,{date='synthetic-date',runClass='standard',abilityIds=[]}={}) {
    if(!['standard','assisted'].includes(runClass)||runClass==='standard'&&abilityIds.length)this.error('CLASS');
    const fingerprint=JSON.stringify([date,runClass,[...abilityIds].sort()]);const k=actor+':'+key;
    if(this.keys.has(k)){const s=this.sessions.get(this.keys.get(k));if(s.fingerprint!==fingerprint)this.error('KEY_CONFLICT');return s;}
    const active=this.slots.get(actor);if(active&&['PREPARED','STARTED'].includes(this.effective(this.sessions.get(active)).state))this.error('ACTIVE_SESSION');
    const s={id:`session-${++this.next}`,actor,date,runClass,fingerprint,state:'PREPARED',revision:1,deadline:this.now+300000,nonce:`synthetic-${this.next}`,gridHash:'fixture-grid',method:'playable-receipt-v2',competition:'fixture-policy'};
    this.sessions.set(s.id,s);this.keys.set(k,s.id);this.slots.set(actor,s.id);return s;
  }
  ready(actor,id,key,nonce,hash='fixture-grid') {
    const s=this.owned(actor,id),request=JSON.stringify([key,nonce,hash]);
    if(s.readyRequest===request)return s;
    this.effective(s);if(s.state!=='PREPARED')this.error(s.state);
    if(nonce!==s.nonce||hash!==s.gridHash)this.error('READY_BINDING');
    s.readyRequest=request;s.startedAt=this.now;s.state='STARTED';s.deadline=this.now+7200000;s.revision++;return s;
  }
  complete(actor,id,{clientElapsed,commit=true,clockHealthy=true}={}) {
    const s=this.owned(actor,id);if(s.result)return s.result;
    this.effective(s);if(s.state!=='STARTED')this.error(s.state);
    if(clientElapsed!==undefined)this.error('CLIENT_CLOCK');
    if(!commit)this.error('BEFORE_COMMIT');
    const claim=s.actor+':'+s.date,first=!this.claims.has(claim);
    // A reservation models exactly-once eligibility, NOT an inventory award.
    this.claims.add(claim);
    s.result=Object.freeze({id:`result-${s.id}`,attemptId:s.id,receivedAt:this.now,elapsedMs:this.now-s.startedAt,eligibilityReserved:first,reward:'held'});
    s.decision=clockHealthy&&s.result.elapsedMs>=0?'pending':'quarantined';s.decisionRevision=0;
    s.state='COMPLETED';s.revision++;this.slots.delete(s.actor);
    this.events.push({id:s.id,revision:0});return s.result;
  }
  abandon(actor,id) {const s=this.effective(this.owned(actor,id));if(s.state==='ABANDONED')return s;if(!['PREPARED','STARTED'].includes(s.state))this.error(s.state);s.state='ABANDONED';s.revision++;this.slots.delete(actor);return s;}
  decide(actor,id,decision) {if(!['accepted','quarantined','rejected'].includes(decision))this.error('DECISION');const s=this.owned(actor,id);if(!s.result)this.error('NO_RESULT');if(decision==='accepted'&&s.result.elapsedMs<0)this.error('CLOCK');s.decision=decision;s.decisionRevision++;const event={id,revision:s.decisionRevision};this.events.push(event);return event;}
  project() {
    // Recompute from CURRENT decisions: duplicate or stale events cannot revive
    // a rejected winner. A production projection needs transactional revisions.
    this.best.clear();
    for(const s of this.sessions.values())if(s.decision==='accepted'){
      const k=JSON.stringify([s.actor,s.date,s.method,s.competition,s.runClass]);const previous=this.best.get(k);
      const rank=x=>[x.result.elapsedMs,x.result.receivedAt,x.id];
      const a=rank(s),b=previous&&rank(previous);
      if(!previous||a[0]<b[0]||a[0]===b[0]&&(a[1]<b[1]||a[1]===b[1]&&a[2]<b[2]))this.best.set(k,s);
    }
    return [...this.best.values()].map(s=>({actor:s.actor,runClass:s.runClass,...s.result}));
  }
}
