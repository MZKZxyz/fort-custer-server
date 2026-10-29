// Trusted bootstrap in a digest-pinned image, NOT an attestation against host root.
import { readdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const manifestPath = '/app/proof-manifest.json';
export async function measurement(root = '/app') {
  const rows = [];
  async function walk(path, relative = '') {
    for (const name of (await readdir(path)).sort()) {
      if (!relative && name === 'proof-manifest.json') continue;
      const file = join(path, name), rel = relative ? `${relative}/${name}` : name;
      const stat = await lstat(file);
      // npm's executable symlinks are outside the runtime module graph.
      if (stat.isSymbolicLink() && /^node_modules\/(?:.*\/)?\.bin\/[^/]+$/.test(rel)) continue;
      if (stat.isDirectory()) await walk(file, rel);
      else if (stat.isFile()) rows.push([rel, createHash('sha256').update(await readFile(file)).digest('hex')]);
      else throw Error('SOURCE_UNSAFE');
    }
  }
  await walk(root);
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}
export async function assertImage() {
  const expected = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (await measurement() !== expected.hash) throw Error('SOURCE_MODIFIED');
  return expected;
}
if (process.argv[2] === '--write') {
  await writeFile(manifestPath, JSON.stringify({ sourceSha: process.argv[3], hash: await measurement() }));
}
