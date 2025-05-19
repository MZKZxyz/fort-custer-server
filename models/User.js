import mongoose from 'mongoose';

const SubProfileSchema = new mongoose.Schema({
  name: { type: String, required: true },
  avatar: { type: String },
  age: { type: Number },
  progress: { type: Map, of: Object, default: {} }, // e.g., {"2025-05-26": { completed: true, time: 132 }}
  rewards: {
    type: Map,
    of: Number, // item ID -> quantity
    default: {},
  }, 
  attempts: {
    type: Map,
    of: [
      new mongoose.Schema(
        {
          started: { type: Date, required: true },
          completed: { type: Boolean, default: false },
          time: { type: Number }, // seconds (or ms, if you prefer)
        },
        { _id: false }
      )
    ],
    default: {},
  },
});


const UserSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  subProfiles: [SubProfileSchema]
}, { timestamps: true });

const User = mongoose.model('User', UserSchema);

export default User;
