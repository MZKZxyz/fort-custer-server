import mongoose from 'mongoose';
import Maze from '../../models/Maze.js';
import { publishMaze } from '../../services/publication/publisher.js';
process.once('message', async ({ uri, input, now }) => {
  if (!/^mongodb:\/\/127\.0\.0\.1:\d+\/fc_publication_synthetic_race\?replicaSet=fcSynthetic$/.test(uri)) throw Error('UNSAFE_FIXTURE');
  try {
    // Short, local fixture operations: 2s discovery/connect and 3s socket budgets.
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 2000, connectTimeoutMS: 2000, socketTimeoutMS: 3000 }); await Maze.init();
    const model = { db: Maze.db, collection: Maze.collection, findOne: Maze.findOne.bind(Maze), create: async (...args) => {
      process.send({ stage: 'candidate' });
      await new Promise(resolve => process.once('message', resolve));
      return Maze.create(...args);
    } };
    const result = await publishMaze({ model, input, now });
    process.send({ result });
  } catch (error) { process.send({ error: error.code ?? 'FIXTURE_FAILED' }); }
  finally { await mongoose.disconnect(); process.disconnect(); }
});
