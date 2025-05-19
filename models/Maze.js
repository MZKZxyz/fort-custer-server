import mongoose from 'mongoose';

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
  }
}, { timestamps: true });

export default mongoose.model('Maze', MazeSchema);
