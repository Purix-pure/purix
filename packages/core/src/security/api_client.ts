// packages/core/src/security/api_client.ts
//
// Thin fetch wrapper for packages/api — the only network calls Purix's
// core pipeline makes. Every other module (classify, gates, sandbox
// verify, self-heal, escalation, drift, migration, scaffold) stays fully
// local, per the architecture doc's opening paragraph; this file is the
// entire surface where that stops being true, and it's deliberately
// narrow: login, entitlements, sync, nothing else.
import { loadSession as defaultLoadSession, type SessionStore } from "./session.js";

const DEFAULT_BASE_URL = "https://api.purix.dev";

function baseUrl(): string {
  return process.env.PURIX_API_URL ?? DEFAULT_BASE_URL;
}

/**
 * Distinguishes "the network/API is unreachable" from "the API responded
 * and rejected the request" — tier.ts's offline-grace logic needs exactly
 * this distinction (serve stale cache on ApiUnreachableError, but never
 * on a real 401/403 from the server).
 */
export class ApiUnreachableError extends Error {
  constructor(cause: unknown) {
    super(`Purix API unreachable: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "ApiUnreachableError";
  }
}

export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export interface EntitlementsResponse {
  tier: "free" | "pro" | "team" | "enterprise";
  flags: Record<string, boolean | number | string | null>;
  cacheTtlSeconds: number;
}

/**
 * Factory rather than a bare set of module functions, same reasoning as
 * secrets_manager.ts and session.ts: `loadSessionFn` defaults to the real
 * session store but tests can inject one bound to a throwaway directory,
 * so a test never has to fight Bun's non-live-reading os.homedir() to
 * isolate itself from the real machine's session.
 */
export function createApiClient(loadSessionFn: SessionStore["loadSession"] = defaultLoadSession) {
  async function request<T>(path: string, init: RequestInit = {}, authenticated = false): Promise<T> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "X-Purix-Client-Version": "0.1.0",
      ...(init.headers as Record<string, string> | undefined),
    };

    if (authenticated) {
      const session = loadSessionFn();
      if (!session) {
        throw new ApiRequestError(401, "Not logged in — run `purix login` first.");
      }
      headers.authorization = `Bearer ${session.token}`;
    }

    let response: Response;
    try {
      response = await fetch(`${baseUrl()}${path}`, { ...init, headers });
    } catch (err) {
      throw new ApiUnreachableError(err);
    }

    if (!response.ok) {
      let message = `Request to ${path} failed with status ${response.status}`;
      try {
        const body = (await response.json()) as { error?: string };
        if (body.error) message = body.error;
      } catch {
        // non-JSON error body — fall back to the generic message above
      }
      throw new ApiRequestError(response.status, message);
    }

    return (await response.json()) as T;
  }

  return {
    requestCode(email: string): Promise<void> {
      return request<void>("/auth/request-code", { method: "POST", body: JSON.stringify({ email }) });
    },

    verifyCode(email: string, code: string): Promise<{ token: string }> {
      return request<{ token: string }>("/auth/verify-code", {
        method: "POST",
        body: JSON.stringify({ email, code }),
      });
    },

    logout(): Promise<void> {
      return request<void>("/auth/logout", { method: "POST" }, true);
    },

    getEntitlements(): Promise<EntitlementsResponse> {
      return request<EntitlementsResponse>("/entitlements", { method: "GET" }, true);
    },

    syncSavings(
      batches: { projectId: string; machineId: string; windowStart: string; totalSavingsUsd: number; callCount: number }[]
    ): Promise<void> {
      return request<void>("/sync/savings", { method: "POST", body: JSON.stringify({ batches }) }, true);
    },
  };
}

/** Real default instance — cli/commands/auth.ts and licensing/tier.ts use this. */
export const apiClient = createApiClient();
