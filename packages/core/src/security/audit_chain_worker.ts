// Test worker: appends N records to the audit chain of the store in the current directory, then exits.
// Usage: tsx audit_chain_worker.ts <dir> <count> <label>
import { appendAuditRecord } from "./audit_tamper_evidence.js";
const [dir, count, label] = process.argv.slice(2);
process.chdir(dir!);
for (let i = 0; i < Number(count); i++) appendAuditRecord({ w: label, i });
