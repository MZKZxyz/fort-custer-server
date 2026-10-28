// Local disposable rehearsal ledger. Not a cross-host production authority.
import { constants } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { digest, canonical } from './artifacts.mjs';
import { fail } from '../../services/publication/ingress.js';

export class RehearsalLedger {
  constructor(root) { this.root = root; }
  async check() {
    const stat = await lstat(this.root);
    if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700 || stat.uid !== process.getuid()) throw fail('LEDGER_UNSAFE');
  }
  path(kind, id) { return join(this.root, `${kind}-${digest(id)}.json`); }
  async exclusive(path, value) {
    const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(canonical(value)); await file.sync(); } finally { await file.close(); }
    const dir = await open(this.root, constants.O_RDONLY);
    try { await dir.sync(); } finally { await dir.close(); }
  }
  async claim(record) {
    await this.check();
    try {
      await this.exclusive(this.path('approval', record.approvalId), record);
      // Permanent one-attempt date claim, including failures/crashes. Never unlink.
      await this.exclusive(this.path('date', [record.namespaceHash, record.date]), record);
    } catch (e) { throw fail(e.code === 'EEXIST' ? 'APPROVAL_OR_DATE_SPENT' : 'LEDGER_UNAVAILABLE'); }
  }
  async available(record) {
    await this.check();
    for (const path of [this.path('approval', record.approvalId), this.path('date', [record.namespaceHash, record.date])]) {
      try { await lstat(path); } catch (e) { if (e.code === 'ENOENT') continue; throw fail('LEDGER_UNAVAILABLE'); }
      throw fail('APPROVAL_OR_DATE_SPENT');
    }
  }
  async require(record) {
    await this.check();
    const file = await open(this.path('approval', record.approvalId), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid()) throw fail('LEDGER_UNSAFE');
      if ((await file.readFile('utf8')) !== canonical(record)) throw fail('LEDGER_MISMATCH');
    } finally { await file.close(); }
  }
  async finish(record, report) {
    await this.check(); await this.exclusive(this.path('report', record.approvalId), report);
  }
}
