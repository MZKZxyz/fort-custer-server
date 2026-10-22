# Fort Custer API development

Use Node.js 24 and `npm ci` to install the locked dependencies.

For local development, run a MongoDB instance bound to `127.0.0.1`, then start the API with a dedicated development database:

```sh
MONGO_URI=mongodb://127.0.0.1:27017/fort_custer_development PORT=5000 npm run dev
```

Supply `JWT_SECRET` through your local environment. Do not use production database credentials or modify Atlas access lists for development.

## Isolated gameplay tests

Install MongoDB 8.0 locally and put `mongod` on PATH, or specify its executable:

```sh
MONGOD_BINARY=/absolute/path/to/mongod npm test
```

The tests launch their own MongoDB process on a loopback port with a fresh temporary data directory. They ignore `MONGO_URI`, use a synthetic JWT signing key, create synthetic users, mazes, and rewards, and stop the database and remove its files afterward. They exercise the actual Express routes and Mongoose persistence, including simultaneous completion requests. They do not require Atlas, production data, external integrations, or an already running API.

Invalid attempt requests return 400. Missing users/profiles return 404. A completed attempt or a concurrent profile update returns 409; reload the profile before trying again. A successful completion is saved with optimistic concurrency so simultaneous requests cannot both award rewards. Starting a new attempt still allows replay.

These tests cover API completion reliability, not browser rendering or full maze navigation. The separate client currently has a CRA/Jest React Router resolution failure. Existing maze generation and seasonal leaderboards use the 2025 season; the reward seeder also assumes a different client checkout path. Do not run that destructive seeder against shared data.
