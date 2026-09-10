// packages/core/src/security/session.ts
//
// Part 4: the machine-global session store. Built on the secrets_manager
// factory from a moment ago, instantiated at ~/.purix with its own
// independent master key — deliberately NOT the project-local .purix/
// store providers.ts and cli/commands/security.ts use, since "session
// identity is machine-scoped" (per the architecture doc) has to mean a
// key that isn't tied to whichever repo happened to be cwd first.
//
// One caveat worth a comment rather than a surprise later: the
// underlying SecretRecord shape carries 90-day rotation tracking built
// for provider API keys (rotated_at, rotationDue at listSecretStatus()
// time). A session token already expires via its own JWT `exp` claim, so
// a "rotation due" flag on it is meaningless — harmless as long as
// nothing ever surfaces listSecretStatus() output for this store
// specifically. If a `purix security list`-equivalent for the
// machine-global store gets built later, it should ignore/hide
// rotationDue for the "session" entry rather than showing a confusing
// warning about something that isn't rotated that way.
import { homedir } from "node:os";
import { join } from "node:path";
import { createSecretsStore } from "./secrets_manager.js";

const SESSION_KEY = "session";

export interface StoredSession {
  token: string;
  email: string;
  /** ISO timestamp of when this token was issued, for display in `purix login` status output. */
  issuedAt: string;
}

export interface SessionStore {
  saveSession(token: string, email: string): void;
  loadSession(): StoredSession | null;
  clearSession(): void;
  isLoggedIn(): boolean;
}

/**
 * Factory rather than a bare module-level singleton — mirrors
 * createSecretsStore's shape for the same reason: tests need to point
 * this at a throwaway directory. Note this can't be done via a
 * process.env.HOME override at test time the way one might expect,
 * because Bun's os.homedir() resolves the home directory once and does
 * NOT re-read a runtime-modified process.env.HOME (Node's homedir() does;
 * Bun's doesn't) — an env-var redirect silently no-ops under Bun and a
 * test relying on it would quietly write into the real home directory.
 * Passing baseDir explicitly sidesteps that entirely.
 */
export function createSessionStore(baseDir: string): SessionStore {
  const store = createSecretsStore(baseDir, "session.enc");

  return {
    saveSession(token, email) {
      const record: StoredSession = { token, email, issuedAt: new Date().toISOString() };
      store.setSecret(SESSION_KEY, JSON.stringify(record));
    },

    loadSession() {
      const raw = store.getSecret(SESSION_KEY);
      if (!raw) return null;
      try {
        return JSON.parse(raw) as StoredSession;
      } catch {
        return null;
      }
    },

    clearSession() {
      store.deleteSecret(SESSION_KEY);
    },

    isLoggedIn() {
      const raw = store.getSecret(SESSION_KEY);
      return raw !== null;
    },
  };
}

// Default instance — the real machine-global store at ~/.purix that
// cli/commands/auth.ts and licensing/tier.ts use. Tests should call
// createSessionStore(tmpDir) directly instead of importing these.
const defaultStore = createSessionStore(join(homedir(), ".purix"));

export const saveSession = defaultStore.saveSession;
export const loadSession = defaultStore.loadSession;
export const clearSession = defaultStore.clearSession;
export const isLoggedIn = defaultStore.isLoggedIn;
