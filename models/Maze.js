import mongoose from 'mongoose';
import { validManifest, PUBLICATION_ERA } from '../services/publication/policy.js';

const ProvenanceSchema = new mongoose.Schema({
  manifestVersion: { type: String, required: true },
  algorithmVersion: { type: String, required: true },
  configVersion: { type: String, required: true },
  rngVersion: { type: String, required: true },
  config: { type: mongoose.Schema.Types.Mixed, required: true },
  configHash: { type: String, required: true },
  identityHash: { type: String, required: true },
  gridHash: { type: String, required: true },
  acceptedAttempt: { type: Number, required: true },
  attempts: { type: [new mongoose.Schema({ attempt: { type: Number, required: true },
    code: { type: String, required: true } }, { _id: false, strict: 'throw' })], required: true },
}, { _id: false, strict: 'throw' });

const MazeSchema = new mongoose.Schema({
  date: {
    type: String, // YYYY-MM-DD
    unique: true,
    required: true,
  },
  seed: {
    type: String,
    required: true,
  },
  grid: {
    type: [[String]], // 2D array of strings: 'S', 'E', '#', ' ', etc.
    required: true,
  },
  width: {
    type: Number,
    required: true,
  },
  height: {
    type: Number,
    required: true,
  },
  collectibles: {
    type: [[String]], // optional: collectible IDs or types per cell
    default: [],
  },
  // Additive: markerless historical rows remain loadable without a migration.
  publicationEra: { type: String, enum: [PUBLICATION_ERA], immutable: true },
  publishedAt: { type: Date, immutable: true },
  provenance: { type: ProvenanceSchema, immutable: true },
}, { timestamps: true });
MazeSchema.index({ publicationEra: 1, date: 1, publishedAt: 1 });

// Supported Mongoose writers cannot rewrite published or historical content.
for (const key of ['date', 'seed', 'grid', 'width', 'height', 'collectibles']) MazeSchema.path(key).immutable(true);
MazeSchema.pre('validate', function () {
  if (!this.isNew && ['date', 'seed', 'grid', 'width', 'height', 'collectibles', 'publicationEra', 'publishedAt', 'provenance']
    .some(key => this.isModified(key))) throw new Error('MAZE_INSERT_ONLY');
  if ([this.publicationEra, this.publishedAt, this.provenance].some(value => value !== undefined)
      && !validManifest(this.toObject())) this.invalidate('provenance', 'INVALID_PUBLICATION_MANIFEST');
});
MazeSchema.pre(['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace'], function () {
  throw new Error('MAZE_INSERT_ONLY');
});
MazeSchema.pre('bulkWrite', function (next, operations) {
  next(operations.some(operation => !operation.insertOne) ? new Error('MAZE_INSERT_ONLY') : undefined);
});

export default mongoose.model('Maze', MazeSchema);
