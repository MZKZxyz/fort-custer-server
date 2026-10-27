// Operator-reviewed library only: no CLI, URI handling, connection, model imports or writes.
// Production execution needs separate authorization; see docs/release/schema-assessment.md.
export const MAX_TIME_MS = 10000;
export const SHARED_COLLECTIONS = Object.freeze([
  'sessions', 'slots', 'keys', 'intents', 'transcripts', 'results', 'outbox', 'observations',
  'dateHistory', 'dateLedger', 'progress', 'writerEpochs', 'profileOrigins', 'mazeOrigins',
  'grants', 'deliveries', 'legacyIntents', 'legacyReceipts',
].map(name => `fc_v2_${name}`));
const core = ['users', 'mazes', 'rewarditems'];
const allowedCollections = [...core, ...SHARED_COLLECTIONS];
const readActions = new Set(['find', 'listCollections', 'listIndexes', 'listSearchIndexes',
  'collStats', 'dbStats', 'dbHash', 'killCursors', 'planCacheRead', 'changeStream']);
const refused = code => { throw new Error(code); };
const type = path => ({ $type: path });
const eq = (a, b) => ({ $eq: [a, b] });
const ne = (a, b) => ({ $ne: [a, b] });
const and = (...values) => ({ $and: values });
const not = value => ({ $not: [value] });
const object = path => eq(type(path), 'object');
const array = path => eq(type(path), 'array');
const exists = path => ne(type(path), 'missing');
const numeric = path => ({ $in: [type(path), ['int', 'long', 'double', 'decimal']] });
const safeArray = path => ({ $cond: [array(path), path, []] });
const entries = path => ({ $cond: [object(path), { $objectToArray: path }, []] });
const sum = expression => ({ $sum: { $cond: [expression, 1, 0] } });
const safeInteger = path => {
  const value = { $cond: [numeric(path), path, -1] };
  return and(numeric(path), { $gte: [value, 0] }, { $lte: [value, Number.MAX_SAFE_INTEGER] },
    eq({ $trunc: value }, value));
};
const safeKey = path => and(eq(type(path), 'string'), {
  $regexMatch: { input: { $cond: [eq(type(path), 'string'), path, ''] }, regex: /^[^.$][^.]*$/ },
}, not({ $in: [path, ['__proto__', 'constructor', 'prototype']] }));
const validDateKey = path => ({ $let: {
  vars: { parsed: { $dateFromString: { dateString: path, format: '%Y-%m-%d', onError: null, onNull: null } } },
  in: and(ne('$$parsed', null), eq({ $dateToString: { date: '$$parsed', format: '%Y-%m-%d', onNull: '' } }, path)),
} });
const uuid = path => and(eq(type(path), 'string'), { $regexMatch: {
  input: { $cond: [eq(type(path), 'string'), path, ''] },
  regex: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
} });
const countGroup = fields => [
  { $group: { _id: null, ...Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, sum(value)])) } },
  { $project: { _id: 0 } },
];
const profiles = [
  { $project: { _id: 0, profile: safeArray('$subProfiles') } },
  { $unwind: '$profile' },
];
const inventory = [...profiles, { $project: { row: entries('$profile.rewards') } }, { $unwind: '$row' }];
const buckets = [...profiles, { $project: { row: entries('$profile.attempts') } }, { $unwind: '$row' }];
const attempts = [...buckets, { $project: { attempt: safeArray('$row.v') } }, { $unwind: '$attempt' }];

// Every pipeline ends with one fixed-key count row. Values/keys never leave MongoDB.
export function assessmentPlans() {
  return [
    { name: 'users', collection: 'users', fields: {
      total: true, versionMissing: not(exists('$__v')), versionNull: eq(type('$__v'), 'null'),
      versionInt: eq(type('$__v'), 'int'), versionLong: eq(type('$__v'), 'long'),
      versionDouble: eq(type('$__v'), 'double'), versionDecimal: eq(type('$__v'), 'decimal'),
      versionString: eq(type('$__v'), 'string'),
      versionOther: not({ $in: [type('$__v'), ['missing', 'null', 'int', 'long', 'double', 'decimal', 'string']] }),
      versionInvalid: not(safeInteger('$__v')),
      profilesMissing: not(exists('$subProfiles')),
      profilesMalformed: and(exists('$subProfiles'), not(array('$subProfiles'))),
      nonArrayWriterSentinelPresent: and(not(array('$subProfiles')), exists('$subProfiles.collectibleWriterVersion')),
    }, prefix: [] },
    { name: 'profiles', collection: 'users', fields: {
      total: true, malformedElements: not(object('$profile')),
      writerSentinelPresent: and(object('$profile'), exists('$profile.collectibleWriterVersion')),
      ...Object.fromEntries(['attempts', 'progress', 'rewards'].flatMap(name => [
        [`${name}Missing`, and(object('$profile'), not(exists(`$profile.${name}`)))],
        [`${name}Malformed`, and(object('$profile'), exists(`$profile.${name}`), not(object(`$profile.${name}`)))],
      ])),
    }, prefix: profiles },
    { name: 'inventory', collection: 'users', fields: {
      entries: true, unsafeKeys: not(safeKey('$row.k')), invalidQuantities: not(safeInteger('$row.v')),
      zeroQuantities: and(numeric('$row.v'), eq('$row.v', 0)),
      multipleQuantities: and(safeInteger('$row.v'), { $gt: ['$row.v', 1] }),
      numericStringQuantities: and(eq(type('$row.v'), 'string'), ne({ $convert: {
        input: '$row.v', to: 'double', onError: null, onNull: null,
      } }, null)),
    }, prefix: inventory },
    { name: 'attemptDates', collection: 'users', fields: {
      total: true, invalidDateKeys: not(validDateKey('$row.k')), malformedArrays: not(array('$row.v')),
    }, prefix: buckets },
    { name: 'attempts', collection: 'users', fields: {
      total: true, malformedElements: not(object('$attempt')),
      withUuid: uuid('$attempt.attemptId'), withoutId: and(object('$attempt'), not(exists('$attempt.attemptId'))),
      invalidIds: and(object('$attempt'), exists('$attempt.attemptId'), not(uuid('$attempt.attemptId'))),
      activeIdless: and(object('$attempt'), ne('$attempt.completed', true), not(exists('$attempt.attemptId'))),
      completedWithoutSnapshot: and(eq('$attempt.completed', true), { $in: [type('$attempt.result'), ['missing', 'null']] }),
      savedSnapshots: object('$attempt.result'),
      malformedSnapshots: and(exists('$attempt.result'), ne(type('$attempt.result'), 'null'), not(object('$attempt.result'))),
      invalidStarts: and(object('$attempt'), ne(type('$attempt.started'), 'date')),
      futureStarts: and(eq(type('$attempt.started'), 'date'), { $gt: ['$attempt.started', '$$NOW'] }),
      invalidCompletedFlags: and(object('$attempt'), exists('$attempt.completed'), ne(type('$attempt.completed'), 'bool')),
    }, prefix: attempts },
    { name: 'progress', collection: 'users', fields: {
      entries: true, invalidDateKeys: not(validDateKey('$row.k')), malformedEntries: not(object('$row.v')),
    }, prefix: [...profiles, { $project: { row: entries('$profile.progress') } }, { $unwind: '$row' }] },
    { name: 'catalog', collection: 'rewarditems', fields: {
      total: true, missingIds: not(exists('$id')), nullIds: eq(type('$id'), 'null'),
      numericIds: numeric('$id'), stringIds: eq(type('$id'), 'string'),
      otherIdTypes: not({ $in: [type('$id'), ['missing', 'null', 'string', 'int', 'long', 'double', 'decimal']] }),
      unsafeStringIds: and(eq(type('$id'), 'string'), not(safeKey('$id'))),
      legacyDisplayVariants: not(and(...['name', 'image', 'description', 'category', 'rarity']
        .map(key => eq(type(`$${key}`), 'string')))),
    }, prefix: [] },
    { name: 'catalogDuplicates', collection: 'rewarditems', fields: null, pipeline: [
      { $match: { $expr: { $or: [eq(type('$id'), 'string'), numeric('$id')] } } },
      { $group: { _id: { $convert: { input: '$id', to: 'string', onError: null, onNull: null } }, rows: { $sum: 1 } } },
      { $group: { _id: null, duplicateGroups: sum({ $gt: ['$rows', 1] }),
        extraRows: { $sum: { $subtract: ['$rows', 1] } } } },
      { $project: { _id: 0 } },
    ], keys: ['duplicateGroups', 'extraRows'] },
  ].map(({ fields, prefix, ...plan }) => ({ ...plan,
    keys: plan.keys ?? Object.keys(fields), pipeline: plan.pipeline ?? [...prefix, ...countGroup(fields)],
  }));
}

function validateScope(db, approval) {
  if (!approval || Object.keys(approval).sort().join(',') !== 'collectionNames,databaseName,dedicatedDatabaseConfirmed'
      || approval.dedicatedDatabaseConfirmed !== true || typeof approval.databaseName !== 'string'
      || !/^[A-Za-z0-9_-]{1,63}$/.test(approval.databaseName)
      || ['admin', 'local', 'config', 'test'].includes(approval.databaseName)
      || db.databaseName !== approval.databaseName || !Array.isArray(approval.collectionNames)
      || new Set(approval.collectionNames).size !== approval.collectionNames.length
      || !core.every(name => approval.collectionNames.includes(name))
      || !approval.collectionNames.every(name => allowedCollections.includes(name))) refused('AUDIT_SCOPE_REFUSED');
  // An unbounded driver must not turn a bounded server command into an indefinite wait.
  for (const key of ['serverSelectionTimeoutMS', 'connectTimeoutMS', 'socketTimeoutMS']) {
    const value = db.client?.options?.[key];
    if (!Number.isInteger(value) || value < 1 || value > 15000) refused('AUDIT_TIMEOUT_CONFIGURATION_REQUIRED');
  }
}

function validatePrivileges(status, approval) {
  const info = status.authInfo;
  const privileges = info?.authenticatedUserPrivileges;
  if (info?.authenticatedUsers?.length !== 1 || !Array.isArray(privileges) || !privileges.length) {
    refused('AUDIT_READ_ONLY_PRIVILEGES_REQUIRED');
  }
  for (const privilege of privileges) {
    const resource = privilege.resource;
    if (!resource || Object.keys(resource).sort().join(',') !== 'collection,db'
        || resource.db !== approval.databaseName
        // MongoDB 8's built-in read role also grants read-only system.js metadata.
        // This permits that privilege only; an actual system.js collection is out of scope.
        || !['', 'system.js', ...approval.collectionNames].includes(resource.collection)
        || !Array.isArray(privilege.actions) || !privilege.actions.length
        || !privilege.actions.every(action => readActions.has(action))) refused('AUDIT_READ_ONLY_PRIVILEGES_REQUIRED');
  }
  if (!core.every(collection => privileges.some(p => p.actions.includes('find')
      && ['', collection].includes(p.resource.collection)))
      || !privileges.some(p => p.resource.collection === '' && p.actions.includes('listCollections'))) {
    refused('AUDIT_READ_ONLY_PRIVILEGES_REQUIRED');
  }
}

function countRow(response, keys) {
  if (response.cursor?.id?.toString() !== '0' || !Array.isArray(response.cursor.firstBatch)
      || response.cursor.firstBatch.length > 1) refused('AUDIT_COUNT_SHAPE_REFUSED');
  const row = response.cursor.firstBatch[0] ?? Object.fromEntries(keys.map(key => [key, 0]));
  if (Object.keys(row).sort().join(',') !== [...keys].sort().join(',')
      || Object.values(row).some(value => !Number.isSafeInteger(value) || value < 0)) refused('AUDIT_COUNT_SHAPE_REFUSED');
  return row;
}

export async function assessSchema(db, approval) {
  // Never leak a driver/server exception, partial counts, collection names or principal.
  try {
    validateScope(db, approval);
    const command = body => db.command({ ...body, maxTimeMS: MAX_TIME_MS }, { readPreference: 'primary' });
    validatePrivileges(await command({ connectionStatus: 1, showPrivileges: true }), approval);
    const checkInventory = async () => {
      const listed = await command({ listCollections: 1, nameOnly: false, cursor: { batchSize: 100 } });
      const collections = listed.cursor?.firstBatch;
      if (listed.cursor?.id?.toString() !== '0' || !Array.isArray(collections)
        || collections.some(c => c.type !== 'collection' || c.options?.timeseries || c.options?.viewOn)
        || collections.map(c => c.name).sort().join(',') !== [...approval.collectionNames].sort().join(',')) {
        refused('AUDIT_SCOPE_REFUSED');
      }
    };
    await checkInventory();
    const hello = await command({ hello: 1 });
    const build = await command({ buildInfo: 1 });
    if (hello.msg === 'isdbgrid' || hello.serviceId || hello.isWritablePrimary !== true
        || !/^8\.0\.\d+$/.test(build.version)) refused('AUDIT_TOPOLOGY_UNREVIEWED');
    const counts = {};
    for (const plan of assessmentPlans()) {
      counts[plan.name] = countRow(await command({ aggregate: plan.collection, pipeline: plan.pipeline,
        cursor: { batchSize: 2 }, allowDiskUse: false, readConcern: { level: 'majority' } }), plan.keys);
    }
    const shared = approval.collectionNames.filter(name => SHARED_COLLECTIONS.includes(name));
    counts.sharedWriter = { collectionsPresent: shared.length, nonemptyCollections: 0, documents: 0 };
    for (const collection of shared) {
      const row = countRow(await command({ aggregate: collection,
        pipeline: [{ $count: 'total' }], cursor: { batchSize: 2 }, allowDiskUse: false,
        readConcern: { level: 'majority' } }), ['total']);
      counts.sharedWriter.documents += row.total;
      if (!Number.isSafeInteger(counts.sharedWriter.documents)) refused('AUDIT_COUNT_SHAPE_REFUSED');
      if (row.total > 0) counts.sharedWriter.nonemptyCollections++;
    }
    await checkInventory();
    validatePrivileges(await command({ connectionStatus: 1, showPrivileges: true }), approval);
    const hardNoGo = counts.profiles.writerSentinelPresent > 0 || counts.users.nonArrayWriterSentinelPresent > 0
      || counts.sharedWriter.documents > 0;
    // This is evidence for owner review, never an automatic compatibility/release approval.
    return { assessmentVersion: 1, complete: true, disposition: hardNoGo ? 'HARD_NO_GO' : 'OWNER_REVIEW_REQUIRED',
      metadata: { mongoMajor: 8, mongoMinor: 0, mongoPatch: Number(build.version.split('.')[2]),
        topology: hello.setName ? 'replica-set' : 'standalone', readConcern: 'majority', atomicSnapshot: false }, counts };
  } catch (error) {
    const safeCodes = ['AUDIT_SCOPE_REFUSED', 'AUDIT_TIMEOUT_CONFIGURATION_REQUIRED',
      'AUDIT_READ_ONLY_PRIVILEGES_REQUIRED', 'AUDIT_COUNT_SHAPE_REFUSED', 'AUDIT_TOPOLOGY_UNREVIEWED'];
    throw new Error(safeCodes.includes(error?.message) ? error.message : 'AUDIT_INCOMPLETE');
  }
}
