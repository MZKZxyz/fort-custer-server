// Synthetic process harness for the actual index.js/default app, not DI routers.
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { pathToFileURL } from 'node:url';
let server, currentStats = () => ({});
process.once('message', async ({ root, uri }) => {
  if (!/^mongodb:\/\/127\.0\.0\.1:\d+\/fc_synthetic\?replicaSet=fcSynthetic$/.test(uri)) throw Error('UNSAFE_FIXTURE');
  dotenv.config = () => ({ parsed: {} });
  process.env.JWT_SECRET = 'synthetic-release-test-key';
  process.env.MONGO_URI = uri; process.env.PORT = '0';
  let connectCalls = 0;
  const ddl = [];
  const connect = mongoose.connect.bind(mongoose);
  mongoose.connect = (target, options) => {
    connectCalls++;
    if (target !== uri || options.autoIndex !== false || options.autoCreate !== false) throw Error('UNSAFE_STARTUP');
    // Loopback OLTP fixture only: 2s discovery/connect; 3s socket > 2s metadata command.
    const pending = connect(target, { ...options, serverSelectionTimeoutMS: 2000,
      connectTimeoutMS: 2000, socketTimeoutMS: 3000, monitorCommands: true });
    mongoose.connection.getClient().on('commandStarted', ({ commandName }) => {
      if (['create', 'createIndexes', 'drop', 'dropIndexes', 'collMod'].includes(commandName)) ddl.push(commandName);
    });
    return pending;
  };
  const report = value => process.send({ ...value, connectCalls, ddl });
  currentStats = () => ({ connectCalls, ddl });
  console.error = code => { if (code === 'SERVER_RELEASE_NOT_READY') report({ failure: code }); };
  try {
    const { default: app } = await import(pathToFileURL(`${root}/app.js`));
    const listen = app.listen.bind(app);
    app.listen = (...args) => {
      server = listen(...args);
      server.once('listening', () => report({ port: server.address().port }));
      return server;
    };
    await import(pathToFileURL(`${root}/index.js`));
  } catch (error) { report({ failure: error.code ?? error.message }); }
});
process.on('message', message => {
  if (message?.op === 'stats') process.send({ stats: true, ...currentStats() });
});
process.on('disconnect', async () => {
  server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect(); process.exit();
});
