// Shared production composition; importing it never opens a database or listener.
import express from 'express';
import cors from 'cors';
import userRoutes from './routes/userRoutes.js';
import leaderboardRoutes from './routes/leaderboardRoutes.js';
import mazeRoutes from './routes/mazeRoutes.js';
import { installPlayableRuntime } from './services/playable/runtime.js';

const app = express();
// OFF by default; enabling before all-writer compatibility fails before DB access.
installPlayableRuntime(app);

// Middleware
app.use(cors());
app.use(express.json());

// Routes placeholder
app.get('/', (req, res) => {
  res.send('Fort Custer Maze API is running');
});

app.use('/api/users', userRoutes);
app.use('/api/leaderboard', leaderboardRoutes);
app.use('/api/maze', mazeRoutes);

export default app;
