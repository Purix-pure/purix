// packages/core/src/tools/audit.ts
//
// ADR-060 D8: what goes into the tamper-evident chain. The sink is a port so tests (and any
// future non-database log) can replace it. `record` THROWS if the write fails: the broker treats
// that as "audit unavailable" and refuses to install (fail closed).
import { appendAuditRecord } from "../security/audit_tamper_evidence.js";

export interface ToolsAuditEvent {
  action: "request" | "approval" | "install" | "install_failed" | "remove" | "refused";
  toolId: string;
  origin: "cli" | "agent";
  version?: string;
  lockSha256?: string;
  reason?: string;
  requestId?: string;
}

export interface AuditSink {
  record(event: ToolsAuditEvent): void;
}

export const chainAuditSink: AuditSink = {
  record(event) {
    appendAuditRecord({ kind: "tools", ...event });
  },
};
