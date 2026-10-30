// IPC-only synthetic worker. No private signer keys or network/service selector.
import { runAuthorityFixture } from '../operator-publication/authority-fixture.mjs';
process.once('message', async ({ root, policy, request, hold, barrier }) => {
  const result = await runAuthorityFixture(root, policy, request, {
    clock: () => new Date('2026-06-01T13:00:00.000Z'),
    phase: async state => {
      if (barrier && state === 'PREPARED') {
        const released = new Promise(resolve => process.once('message', message => { if (message.go === true) resolve(); }));
        process.send({ state });
        await released;
      }
      if (state === hold) {
        process.send({ state });
        await new Promise(() => { setInterval(() => {}, 1000); });
      }
    },
  });
  process.send(result, () => process.disconnect());
});
