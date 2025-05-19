import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import User from '../models/User.js';
import { protect } from '../middleware/authMiddleware.js';

dotenv.config();

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET

// Register
router.post('/register', async (req, res) => {
  const { email, password } = req.body;
  try {
    const hashed = await bcrypt.hash(password, 10);
    const user = await User.create({ email, password: hashed });
    res.status(201).json({ message: 'User created' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await User.findOne({ email });
    if (!user) throw new Error('User not found');

    const match = await bcrypt.compare(password, user.password);
    if (!match) throw new Error('Invalid credentials');

    const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { email: user.email, subProfiles: user.subProfiles } });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

// Add a new sub-profile
router.post('/subprofile', protect, async (req, res) => {
  const { name, avatar, age } = req.body;

  try {
    const user = await User.findById(req.user.id);
    user.subProfiles.push({ name, avatar, age });
    await user.save();
    res.status(201).json(user.subProfiles);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/subprofile/:id', protect, async (req, res) => {
  const subProfileId = req.params.id;
  const today = new Date().toISOString().slice(0, 10); // Server-side canonical today

  try {
    const user = await User.findById(req.user.id);
    const sub = user.subProfiles.id(subProfileId);

    if (!sub) {
      return res.status(404).json({ error: 'Sub-profile not found' });
    }

    res.json({
      today,
      subProfile: sub
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/subprofile/:id', protect, async (req, res) => {
  const subProfileId = req.params.id;
  const { name, avatar } = req.body;

  try {
    const user = await User.findById(req.user.id);
    const sub = user.subProfiles.id(subProfileId);

    if (!sub) {
      return res.status(404).json({ error: 'Sub-profile not found' });
    }

    if (name) sub.name = name;
    if (avatar !== undefined) sub.avatar = avatar;

    await user.save();
    res.json(user.subProfiles);
  } catch (err) {
    res.status(500).json({ error: 'Update failed: ' + err.message });
  }
});

router.delete('/subprofile/:id', protect, async (req, res) => {
  const subProfileId = req.params.id;

  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const sub = user.subProfiles.id(subProfileId);
    if (!sub) return res.status(404).json({ error: 'Sub-profile not found' });

    user.subProfiles.pull(subProfileId); // ✅ Remove sub-profile by ID
    await user.save();

    res.json(user.subProfiles);
  } catch (err) {
    res.status(500).json({ error: 'Delete failed: ' + err.message });
  }
});


// Get all sub-profiles
router.get('/subprofiles', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    res.json(user.subProfiles);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Record maze result for a sub-profile
router.post('/subprofile/:id/progress', protect, async (req, res) => {
  const { date, time, collected } = req.body;
  const subProfileId = req.params.id;

  try {
    const user = await User.findById(req.user.id);
    const sub = user.subProfiles.id(subProfileId);

    if (!sub) return res.status(404).json({ error: 'Sub-profile not found' });

    sub.progress.set(date, { completed: true, time, collected });
    await user.save();

    res.status(200).json({ message: 'Progress saved', progress: sub.progress.get(date) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});


export default router;
