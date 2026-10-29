// Private subprocess driver for the disposable proof, never a host entrypoint.
import { status, docker } from '../operator-publication/isolation/lifecycle.mjs';
const state = await status(process.argv[2]);
await docker(['start', state.id]);
process.send({ started: true });
setInterval(() => {}, 1000);
