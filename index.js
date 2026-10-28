// Connection/listen entrypoint; the exact routers are shared with disposable tests.
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import app from './app.js';
import { assertLegacyReleaseReady } from './services/publication/legacy-runtime.js';
import { readIndexReadiness } from './services/publication/readiness.js';
dotenv.config();

// Refuse connection/listen until the committed legacy evidence is approved.
assertLegacyReleaseReady();
const PORT = process.env.PORT || 5000;
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  // Provisioning is an independently approved operation, never a startup side effect.
  autoIndex: false,
  autoCreate: false,
})
.then(async () => {
  const readiness = await readIndexReadiness(mongoose.connection.db);
  if (!readiness.ready) throw new Error('ARCHIVE_INDEXES_REQUIRED');
  app.listen(PORT, () => console.log('Fort Custer Maze API is listening'));
})
.catch(async () => {
  console.error('SERVER_RELEASE_NOT_READY');
  await mongoose.disconnect();
  process.exitCode = 1;
});
