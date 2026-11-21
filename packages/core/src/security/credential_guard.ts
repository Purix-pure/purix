// packages/core/src/security/credential_guard.ts
//
// Rules for saving a credential, so there is never a second, unused or conflicting key for one provider.
//
// What went wrong before: `purix secret set <anything>` accepted any name and any value, replaced an existing entry without
// saying so, and could leave two entries for one provider (`gemini` and `GEMINI_API_KEY`) of which only the second is ever
// read. A stored key is also used before the environment variable of the same name, so an old stored key quietly beat a good
// environment key and the provider answered "API key not valid" with no hint about which copy it had been sent.
//
// This module only decides. It reads and writes nothing itself; the CLI asks it and then stores. The lookups are passed in so
// the rules can be tested without a store on disk.

import { dataDrivenEnv } from "../platform/env.js";
import { knownProviderKeyNames, projectCustomProvider } from "../llm/providers.js";
import { getSecret, listSecretStatus } from "./secrets_manager.js";

/** The one name outside the provider list that Purix reads from the store (the notification webhook signing secret). */
const WEBHOOK_SECRET_NAME = "PURIX_WEBHOOK_SECRET";

export interface KnownCredentialName {
  /** The exact name Purix looks the credential up under. */
  name: string;
  /** What it is for, in words: "Gemini API key". */
  purpose: string;
  /** The provider id it belongs to, when it belongs to one. */
  providerId?: string;
}

export interface GuardContext {
  known: KnownCredentialName[];
  /** Names already in the store. */
  storedNames: string[];
  /** The stored value, or null. Used only to compare, never printed. */
  storedValue(name: string): string | null;
  /** The environment variable of that name, or undefined. */
  envValue(name: string): string | undefined;
}

export type GuardResult = { ok: true; notes: string[] } | { ok: false; reason: string };

/** Characters that mean the value was pasted wrong rather than typed as a key. */
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/**
 * A pasted key goes wrong in a few ways that no provider accepts: nothing at all, a space or newline at either end, quotes that
 * came along from a config line, or a space inside. Each of those is refused here with the reason, before anything is stored,
 * because the store cannot tell a bad key from a good one and the provider only says "not valid" much later.
 */
export function secretValueProblem(value: string): string | null {
  if (value.length === 0) return "The value is empty.";
  if (value.trim().length === 0) return "The value is only whitespace.";
  if (value !== value.trim()) return "The value starts or ends with a space or line break, which was almost certainly pasted by accident. Nothing was stored.";
  if (/^["'`].*["'`]$/.test(value)) return "The value is wrapped in quote marks. Paste the key without them. Nothing was stored.";
  if (CONTROL_RE.test(value)) return "The value contains a line break or control character. Nothing was stored.";
  if (/\s/.test(value)) return "The value contains a space. API keys do not, so this is probably two things pasted together. Nothing was stored.";
  return null;
}

export function defaultGuardContext(baseDir: string = process.cwd()): GuardContext {
  const known: KnownCredentialName[] = knownProviderKeyNames().map((k) => ({ name: k.envVar, purpose: `${k.label} API key`, providerId: k.providerId }));
  let custom: { keyEnvVar: string } | undefined;
  try {
    custom = projectCustomProvider(baseDir);
  } catch {
    custom = undefined; // an unreadable provider-config.json must not stop a person from storing a registry key
  }
  if (custom && !known.some((k) => k.name === custom!.keyEnvVar)) known.push({ name: custom.keyEnvVar, purpose: "custom provider API key", providerId: "custom" });
  known.push({ name: WEBHOOK_SECRET_NAME, purpose: "notification webhook signing secret" });
  return {
    known,
    storedNames: listSecretStatus().map((s) => s.name),
    storedValue: (n) => getSecret(n),
    envValue: (n) => dataDrivenEnv(n),
  };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The known credential a loosely written name was probably meant for: "gemini", "Gemini_Api_Key", "gemini-key". */
export function nameMeant(name: string, known: KnownCredentialName[]): KnownCredentialName | undefined {
  const n = norm(name);
  if (!n) return undefined;
  return known.find((k) => norm(k.name) === n || (k.providerId !== undefined && (n === norm(k.providerId) || n === `${norm(k.providerId)}key` || n === `${norm(k.providerId)}apikey`)));
}

function listNames(known: KnownCredentialName[]): string {
  return known.map((k) => k.name).join(", ");
}

function envConflict(name: string, value: string, ctx: GuardContext): string | null {
  const env = ctx.envValue(name);
  if (env && env !== value) {
    return (
      `The environment variable ${name} is already set to a different value. Purix would use the stored key and ignore the environment one, ` +
      `leaving two different keys for one provider. Make them the same key, or unset the environment variable first. Nothing was stored.`
    );
  }
  return null;
}

/**
 * May `purix secret set <name>` store this value? Refuses when the name is not one Purix reads, when it is a loose spelling of one
 * (the unused-entry mistake), when the credential is already stored (replacing it is `secret rotate`, said out loud), when a
 * differently named entry already exists for the same provider, and when the environment already holds a different key.
 */
export function checkSecretSet(name: string, value: string, ctx: GuardContext): GuardResult {
  const valueProblem = secretValueProblem(value);
  if (valueProblem) return { ok: false, reason: valueProblem };

  const exact = ctx.known.find((k) => k.name === name);
  if (!exact) {
    const meant = nameMeant(name, ctx.known);
    if (meant) {
      return {
        ok: false,
        reason: `"${name}" is not a name Purix reads, so a key stored under it would never be used. The ${meant.purpose} is stored as ${meant.name}. Run: purix secret set ${meant.name}`,
      };
    }
    return { ok: false, reason: `"${name}" is not a credential Purix uses. The names it reads are: ${listNames(ctx.known)}.` };
  }

  if (ctx.storedNames.includes(name)) {
    return {
      ok: false,
      reason:
        `${name} is already stored, so a second key is not saved next to it. To replace it with a new key, run: purix secret rotate ${name}. ` +
        `To go back to the environment variable, run: purix secret remove ${name}.`,
    };
  }

  if (exact.providerId) {
    const sibling = ctx.storedNames.find((s) => s !== name && nameMeant(s, ctx.known)?.name === name);
    if (sibling) {
      return {
        ok: false,
        reason: `An entry named "${sibling}" already exists for the same ${exact.purpose}. Purix never reads it, which is how a wrong key can sit unnoticed. Run: purix secret remove ${sibling}, then set ${name} again.`,
      };
    }
  }

  const conflict = envConflict(name, value, ctx);
  if (conflict) return { ok: false, reason: conflict };

  const notes: string[] = [];
  if (ctx.envValue(name)) notes.push(`${name} is also set in the environment with the same key. The stored copy is used first; you can drop the environment variable.`);
  return { ok: true, notes };
}

/** May `purix secret rotate <name>` store this value? The entry has to exist already; the same value rules apply. */
export function checkSecretRotate(name: string, value: string, ctx: GuardContext): GuardResult {
  const valueProblem = secretValueProblem(value);
  if (valueProblem) return { ok: false, reason: valueProblem };
  if (!ctx.storedNames.includes(name)) {
    const meant = nameMeant(name, ctx.known);
    const hint = meant && meant.name !== name ? ` Did you mean ${meant.name}?` : ` Use "purix secret set ${name}" to create it.`;
    return { ok: false, reason: `No secret stored as "${name}", so there is nothing to rotate.${hint}` };
  }
  const conflict = envConflict(name, value, ctx);
  if (conflict) return { ok: false, reason: conflict };
  return { ok: true, notes: [] };
}

export interface SecretAudit {
  name: string;
  /** Not a name Purix reads: the entry is dead weight and may hold a key someone expects to be used. */
  unused: boolean;
  /** The known name it was probably meant to be, when unused. */
  meant?: string;
  /** Stored and environment values differ; the stored one is used. */
  differsFromEnvironment: boolean;
  /** Characters in the stored value, never the value. */
  length: number | null;
}

/** What `purix secret status` adds to each stored entry. Decrypts locally to measure and compare; returns no value. */
export function auditStoredSecrets(ctx: GuardContext): SecretAudit[] {
  return ctx.storedNames.map((name) => {
    const isKnown = ctx.known.some((k) => k.name === name);
    let value: string | null = null;
    try {
      value = ctx.storedValue(name);
    } catch {
      value = null;
    }
    const env = ctx.envValue(name);
    return {
      name,
      unused: !isKnown,
      meant: isKnown ? undefined : nameMeant(name, ctx.known)?.name,
      differsFromEnvironment: Boolean(value && env && value !== env),
      length: value === null ? null : value.length,
    };
  });
}
