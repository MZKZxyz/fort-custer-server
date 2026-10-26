import mongoose from 'mongoose';
import User from '../../models/User.js';
import Maze from '../../models/Maze.js';
import { hash } from '../playable/repository.js';
import { fail } from '../playable/errors.js';
import { WRITER_VERSION } from './shared-rewards.js';
import { compileGrid } from '../playable/transcript.js';

// No automatic backfill. Only this trusted creation path can mint birth proof.
export class CompatibleLifecycle {
  constructor(rewards) { this.rewards = rewards; this.repo = rewards.repo; }
  async register({ email, password }) {
    return this.repo.tx(async session => {
      await this.rewards.epoch(session);
      const user = new User({ email, password }); await user.save({ session }); return user;
    });
  }
  async addProfile(accountId, { name, avatar, age }) {
    return this.repo.tx(async session => {
      const epoch = await this.rewards.epoch(session);
      const user = await User.findById(accountId).session(session);
      if (!user) fail('NOT_FOUND', 404);
      // Identity/provenance/inventory cannot be supplied by the caller.
      const id = new mongoose.Types.ObjectId();
      user.subProfiles.push({ _id: id, name, avatar, age, collectibleWriterVersion: WRITER_VERSION });
      await user.save({ session }); await this.repo.hook('profile:user');
      const scope = { accountId: user.id, profileId: id.toString() };
      await this.repo.c('profileOrigins').insertOne({ _id: hash(scope), ...scope, version: WRITER_VERSION,
        epochId: epoch._id, birthRevision: epoch.revision + 1, createdAt: Date.now() }, { session });
      await this.repo.hook('profile:origin'); return user;
    });
  }
  async publishNewMaze({ date, seed, grid, width, height }) {
    return this.repo.tx(async session => {
      const epoch = await this.rewards.epoch(session);
      // The certified ceiling includes every date reachable by old writers,
      // including unpublished future mazes. Never bless an existing/old date.
      if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date <= epoch.legacyDateCeiling
        || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))
        || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) fail('PUBLICATION_REQUIRES_NEW_DATE');
      if (await Maze.findOne({ date }).session(session)) fail('MAZE_ALREADY_EXISTS');
      const normalized = compileGrid(grid).rows;
      if (width !== normalized[0].length || height !== normalized.length) fail('GRID_INVALID', 503);
      const maze = new Maze({ date, seed, grid: normalized, width, height }); await maze.save({ session });
      await this.repo.c('mazeOrigins').insertOne({ _id: date, date, version: WRITER_VERSION,
        epochId: epoch._id, birthRevision: epoch.revision + 1, createdAt: Date.now() }, { session }); return maze;
    });
  }
}
