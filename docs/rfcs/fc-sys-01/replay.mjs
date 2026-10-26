import {Sessions} from './model.mjs';
const m=new Sessions(), actor={accountId:'synthetic-account',profileId:'synthetic-profile'};
m.legacy(actor,'fixture-date','clear');
const s=m.create(actor,'create-key');m.tick(12000);
m.ready(actor,s.id,{key:'ready-key',nonce:s.nonce,ifMatch:1});m.tick(600); // lost ACK
m.ready(actor,s.id,{key:'ready-key',nonce:s.nonce,ifMatch:1});m.tick(5900);
const transcript={version:'route-transcript-v1',commands:[{seq:1,dir:'right'}]};
const saved=m.complete(actor,s.id,{key:'complete-key',ifMatch:2,transcript});m.tick(1500);
const replay=m.complete(actor,s.id,{key:'complete-key',ifMatch:2,transcript});
m.decide(actor,s.id,'accepted',{expectedRevision:0});
const entitlement=m.entitlement(actor,'fixture-date');
console.log(JSON.stringify({loadingExcludedMs:12000,startAckDelayChargedMs:600,saved,
  retrySameSnapshot:saved===replay,entitlement,board:m.project()},null,2));
