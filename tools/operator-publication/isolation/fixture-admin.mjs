// Only the disposable harness mounts this account. Never present in writer/gen.
import { readFile } from 'node:fs/promises';
import { client, database, target } from './protocol.mjs';
import { isolationIndexFixtures } from '../../test-support/isolation-index-fixtures.mjs';
const pause = () => new Promise(resolve => setTimeout(resolve, 100));
export async function admin(mode, indexCase) {
  const accounts = JSON.parse(await readFile('/admin/accounts.json', 'utf8'));
  let connection;
  if (mode === 'init') {
    connection = await client();
    await connection.db('admin').command({ replSetInitiate: { _id: 'fcIsolated', members: [{ _id: 0, host: 'localhost:27017' }] } });
    for (let i = 0; i < 150; i++) {
      if ((await connection.db('admin').command({ hello: 1 })).isWritablePrimary) break;
      await pause();
    }
    await connection.db('admin').command({ createUser: accounts.admin.username, pwd: accounts.admin.password, roles: ['root'] });
    await connection.close();
  }
  connection = await client(accounts.admin);
  const db = connection.db(database), authority = connection.db('admin');
  try {
    if (mode === 'init') {
      for (const name of ['mazes', 'claims', 'audit']) await db.createCollection(name);
      await db.collection('mazes').createIndex({ date: 1 }, { unique: true });
      await db.collection('claims').createIndex({ namespace: 1, date: 1 }, { unique: true });
      const privileges = [
        { resource: { db: database, collection: 'mazes' }, actions: ['find', 'insert', 'listIndexes'] },
        { resource: { db: database, collection: '' }, actions: ['listCollections'] },
        ...['claims', 'audit'].map(collection => ({ resource: { db: database, collection }, actions: ['find', 'insert'] })),
      ];
      await authority.command({ createRole: 'fixtureWriter', privileges, roles: [] });
      await authority.command({ createUser: accounts.writer.username, pwd: accounts.writer.password, roles: ['fixtureWriter'] });
      // A separate account can reconcile without any insert privilege.
      await authority.command({ createRole: 'fixtureReader', privileges: ['mazes', 'claims', 'audit'].map(collection => ({
        resource: { db: database, collection }, actions: ['find'],
      })), roles: [] });
      await authority.command({ createUser: accounts.reader.username, pwd: accounts.reader.password, roles: ['fixtureReader'] });
      return { target: await target(db) };
    }
    if (mode === 'counts') return { mazes: await db.collection('mazes').countDocuments(), claims: await db.collection('claims').countDocuments(), audit: await db.collection('audit').countDocuments() };
    if (mode === 'index-fixture') {
      if (indexCase !== 'restore' && !Object.hasOwn(isolationIndexFixtures, indexCase)) throw Error('FIXTURE_INDEX_CASE');
      const fixture = indexCase === 'restore' ? { key: { date: 1 }, options: { unique: true } } : isolationIndexFixtures[indexCase];
      let phase = 'drop';
      try {
        await db.collection('mazes').dropIndex('date_1');
        phase = 'create';
        await db.collection('mazes').createIndex(fixture.key, { ...fixture.options, name: 'date_1' });
      } catch (error) {
        // Bounded fixture diagnostics only; never emit command text or secrets.
        return { code: 'FIXTURE_INDEX_SETUP_FAILED', phase, mongoCode: Number.isInteger(error.code) ? error.code : null,
          transport: ['MongoNetworkError', 'MongoNetworkTimeoutError', 'MongoServerSelectionError'].includes(error.name) };
      }
      return { code: 'FIXTURE_INDEX_CHANGED' };
    }
    if (mode === 'drift') { await db.collection('mazes').createIndex({ seed: 1 }); return { code: 'FIXTURE_DDL_CHANGED' }; }
    throw Error('FIXTURE_ADMIN_MODE');
  } finally { await connection.close(); }
}
