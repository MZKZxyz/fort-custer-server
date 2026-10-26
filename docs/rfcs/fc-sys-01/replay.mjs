import {Sessions} from './model.mjs';
const m=new Sessions();
const s=m.create('synthetic-profile','create-key');m.tick(12000);
m.ready(s.actor,s.id,'ready-key',s.nonce);m.tick(600); // lost ACK, then status recovery
m.ready(s.actor,s.id,'ready-key',s.nonce);m.tick(5900);
const saved=m.complete(s.actor,s.id);m.tick(1500);const replay=m.complete(s.actor,s.id);
m.decide(s.actor,s.id,'accepted');
console.log(JSON.stringify({loadingExcludedMs:12000,startAckDelayChargedMs:600,saved,retrySameSnapshot:saved===replay,board:m.project()},null,2));
