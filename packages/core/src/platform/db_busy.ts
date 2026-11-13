// src/platform/db_busy.ts
//
// H5: a store that another Purix process is writing to is busy, not damaged. Reproduced on a real lock held by a second process:
// `purix status` and `purix stats` waited 5 s and printed a bare "database is locked"; a read-only check built on the same read
// would have called it "damaged"; the start-up audit check wrote "Audit verification FAILED" to its status file, which reads as a
// tamper finding. The rule here: only SQLite's own lock messages count, and corruption messages never do.
const BUSY = /\bSQLITE_BUSY\b|database (?:table )?is locked|still busy after \d+ attempts/i;

export const DATABASE_BUSY_SENTENCE =
  "Another Purix process is using this project's local state right now, so Purix could not read or write it in time. Wait a few seconds and run the command again.";

export function isDatabaseBusy(message: string): boolean {
  return BUSY.test(message);
}
