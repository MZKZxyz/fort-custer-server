import express from 'express';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { fail, errorBody, PlayableError } from '../services/playable/errors.js';
import { PROTOCOL, CAPABILITY, POLICY } from '../services/playable/policy.js';
import { LIMITS } from '../services/playable/transcript.js';

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const oid = value => typeof value === 'string' && /^[a-f0-9]{24}$/.test(value) && mongoose.isObjectIdOrHexString(value);
const key = value => typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value);
const shape = (body, fields) => {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== fields.length
      || fields.some(field => !Object.hasOwn(body, field))) fail('REQUEST_SCHEMA', 400);
};
function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('INVALID_DATE', 400);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail('INVALID_DATE', 400);
}
function expected(req) {
  const header = req.get('If-Match');
  if (header === undefined) return undefined;
  if (!/^(?:[1-9][0-9]*|"[1-9][0-9]*")$/.test(header)) fail('INVALID_REVISION', 400);
  const value = Number(header.replaceAll('"', ''));
  if (!Number.isSafeInteger(value)) fail('INVALID_REVISION', 400);
  return value;
}

// Factory accepts a real application service. The production installer below
// refuses activation; tests/staging assembly can exercise the complete contract.
export function createPlayableRouter({ service, secret, enabled = false, maxInflight = 8, bodyTimeoutMs = 10000 }) {
  const router = express.Router(); let inflight = 0;
  router.use((req, res, next) => {
    if (!enabled) return res.sendStatus(404);
    res.set('Cache-Control', 'no-store');
    try {
      if (!secret || !req.get('Authorization')?.startsWith('Bearer ')) fail('AUTH_REQUIRED', 401);
      let actor;
      try { actor = jwt.verify(req.get('Authorization').slice(7), secret, { algorithms: ['HS256'] }); }
      catch { fail('AUTH_REQUIRED', 401); }
      if (!oid(actor?.id)) fail('AUTH_REQUIRED', 401);
      req.playableAccount = actor.id;
      if (inflight >= maxInflight) fail('SERVER_BUSY', 503);
      inflight++; let released = false;
      const release = () => { if (!released) { released = true; inflight--; } };
      res.once('finish', release); res.once('close', release);
      const bodyTimer = setTimeout(() => req.destroy(), bodyTimeoutMs);
      const clearBodyTimer = () => clearTimeout(bodyTimer);
      req.once('end', clearBodyTimer); req.once('close', clearBodyTimer);
      res.once('close', clearBodyTimer);
      next();
    } catch (error) { next(error); }
  });
  router.use(express.json({ limit: LIMITS.maxBytes + POLICY.maxEnvelopeBytes, inflate: false, strict: true }));
  const run = fn => async (req, res, next) => {
    try { res.json(await fn(req)); } catch (error) { next(error); }
  };
  const actor = (req, read = false) => {
    const profileId = read ? req.query.subProfileId : req.body.subProfileId;
    if (!oid(profileId)) fail('INVALID_PROFILE', 400);
    if (req.params.id !== undefined && !uuid(req.params.id)) fail('INVALID_ATTEMPT', 400);
    return { accountId: req.playableAccount, profileId };
  };
  router.get('/capabilities', run(() => ({ protocol: PROTOCOL, capabilities: [CAPABILITY],
    admission: service.admissionEnabled, timing: 'continuous-server-receipt', publicRanking: false })));
  router.post('/sessions', run(req => {
    shape(req.body, ['subProfileId', 'date', 'createKey']);
    const owned = actor(req); date(req.body.date);
    if (!key(req.body.createKey)) fail('INVALID_KEY', 400);
    if (req.get('X-Fort-Custer-Protocol') !== PROTOCOL || req.get('X-Fort-Custer-Capabilities') !== CAPABILITY) fail('CAPABILITY_REQUIRED', 426);
    return service.create(owned, req.body.createKey, req.body.date);
  }));
  for (const operation of ['ready', 'abandon']) router.post(`/sessions/:id/${operation}`, run(req => {
    const fields = operation === 'ready' ? ['subProfileId', 'key', 'nonce', 'gridHash', 'rulesVersion'] : ['subProfileId', 'key', 'reason'];
    shape(req.body, fields); const owned = actor(req);
    if (!key(req.body.key)) fail('INVALID_KEY', 400);
    const payload = operation === 'ready' ? { nonce: req.body.nonce, gridHash: req.body.gridHash, rulesVersion: req.body.rulesVersion } : { reason: req.body.reason };
    if (operation === 'ready' && (!uuid(payload.nonce) || typeof payload.gridHash !== 'string' || !/^[a-f0-9]{64}$/.test(payload.gridHash)
      || typeof payload.rulesVersion !== 'string')) fail('REQUEST_SCHEMA', 400);
    if (operation === 'abandon' && !['user-choice', 'restart', 'change-grants'].includes(payload.reason)) fail('REQUEST_SCHEMA', 400);
    return service.transition(owned, req.params.id, operation, req.body.key, payload, expected(req));
  }));
  router.post('/sessions/:id/complete', run(req => {
    shape(req.body, ['subProfileId', 'completionKey', 'transcript']); const owned = actor(req);
    if (!key(req.body.completionKey)) fail('INVALID_KEY', 400);
    return service.complete(owned, req.params.id, req.body.completionKey, req.body.transcript, expected(req));
  }));
  for (const operation of ['status', 'result']) router.get(`/sessions/:id/${operation}`, run(req => {
    if (Object.keys(req.query).length !== 1) fail('REQUEST_SCHEMA', 400);
    return service[operation](actor(req, true), req.params.id);
  }));
  router.post('/sessions/:id/recover', run(req => {
    shape(req.body, ['subProfileId']); return service.recover(actor(req), req.params.id);
  }));
  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.type === 'entity.too.large') error = new PlayableError('REQUEST_TOO_LARGE', 413);
    else if (error.type === 'encoding.unsupported') error = new PlayableError('UNSUPPORTED_ENCODING', 415);
    else if (error.type === 'entity.parse.failed') error = new PlayableError('REQUEST_JSON', 400);
    const result = errorBody(error);
    if ([429, 503].includes(result.status)) res.set('Retry-After', '1');
    res.status(result.status).json(result.body);
  });
  return router;
}
