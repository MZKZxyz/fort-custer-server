import mongoose from 'mongoose';

const RewardItemSchema = new mongoose.Schema({
  id: { type: String, unique: true },        // e.g., 'compass', 'arrowhead'
  name: { type: String, required: true },    // 'Lucky Compass'
  image: { type: String, required: true },   // 🧭
  description: { type: String, required: true },
  category: {
    type: String,
    enum: ['trophy', 'tool', 'consumable', 'artifact', 'weapon', 'gear', 'goods'],
    required: true,
  },
  rarity: {
    type: String,
    enum: ['common', 'uncommon', 'rare', 'legendary'],
    required: true,
  },
  marketValue: { type: Number, default: 0 },
});

export default mongoose.model('RewardItem', RewardItemSchema);
