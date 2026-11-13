// packages/core/src/security/api_client.ts
//
// Thin fetch wrapper for packages/api — the only network calls Purix's
// core pipeline makes. Every other module (classify, gates, sandbox
// verify, self-heal, escalation, drift, migration, scaffold) stays fully
// local, per the architecture doc's opening paragraph; this file is the
// entire surface where that stops being true, and it's deliberately
// narrow: login, entitlements, sync, nothing else.
import { purixEnv } from "../platform/env.js";
import { netFetch } from "../platform/net.js";
import { loadSession as defaultLoadSession, saveSession as defaultSaveSession, type SessionStore, type StoredSession } from "./session.js";
import { PURIX_VERSION } from "../version.js";
import { API_ROUTES, DEFAULT_API_BASE_URL, type RouteSpec } from "./api_contract.js";

function baseUrl(): string {
  return purixEnv("PURIX_API_URL") ?? DEFAULT_API_BASE_URL;
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

/** HTTP 401: no session, or the server rejected it. The user must run `purix login`. */
export class LoginRequiredError extends ApiRequestError {
  constructor(message: string) {
    super(401, message);
    this.name = "LoginRequiredError";
  }
}

/** HTTP 426: this client is below the server's minimum version. The user must upgrade. */
export class ClientTooOldError extends ApiRequestError {
  constructor(message: string) {
    super(426, `${message} (client ${PURIX_VERSION}) — upgrade Purix to the latest version, then try again.`);
    this.name = "ClientTooOldError";
  }
}

export interface EntitlementsResponse {
  tier: "free" | "pro" | "team" | "enterprise";
  flags: Record<string, boolean | number | string | null>;
  cacheTtlSeconds: number;
  /** Compact EdDSA JWS carrying the same tier and flags, with version and expiry (see entitlement_signature.ts). */
  signed?: string;
}

/** What the server returns for a login or a refresh. A client that did not ask for refresh gets only `token`. */
export interface LoginResponse {
  token: string;
  refreshToken?: string;
  expiresAt?: string;
  refreshExpiresAt?: string;
  sessionId?: string;
}

/** Who is logging in, so the server can list and revoke this device on its own. */
export interface DeviceIdentity {
  deviceId: string;
  deviceName?: string;
}

export interface SavingsEventPayload {
  machineId: string;
  projectAlias: string;
  events: { localSeq: number; occurredAt: string; callType: string; deltaUsd: number }[];
}

/**
 * Factory rather than a bare set of module functions, same reasoning as
 * secrets_manager.ts and session.ts: `loadSessionFn` defaults to the real
 * session store but tests can inject one bound to a throwaway directory,
 * so a test never has to fight Bun's non-live-reading os.homedir() to
 * isolate itself from the real machine's session.
 */
/** Renew this long before the access token expires, so a call never travels with a token about to die. */
export const REFRESH_AHEAD_MS = 60_000;
/**
 * Never renew ahead twice within this window. A client whose clock runs fast would otherwise see every
 * token as expiring and rotate the single-use refresh token on every call. The 401 path still repairs
 * a token that really did expire inside the window.
 */
export const MIN_REFRESH_GAP_MS = 120_000;

/**
 * C-42: true when the stored session has a refresh token, a readable expiry that is within
 * REFRESH_AHEAD_MS (or already past), a refresh token that has not itself expired, and was not
 * issued in the last MIN_REFRESH_GAP_MS. A legacy session (no refresh token, no expiry) is never
 * renewed ahead: it has nothing to renew with.
 */
export function shouldRefreshAhead(session: StoredSession, now: number = Date.now()): boolean {
  if (!session.refreshToken || !session.expiresAt) return false;
  const expires = Date.parse(session.expiresAt);
  if (Number.isNaN(expires)) return false;
  if (expires - now > REFRESH_AHEAD_MS) return false;
  if (session.refreshExpiresAt) {
    const refreshExpires = Date.parse(session.refreshExpiresAt);
    if (!Number.isNaN(refreshExpires) && refreshExpires <= now) return false; // nothing left to renew with
  }
  const issued = Date.parse(session.issuedAt);
  if (!Number.isNaN(issued) && now - issued < MIN_REFRESH_GAP_MS) return false;
  return true;
}

export function createApiClient(
  loadSessionFn: SessionStore["loadSession"] = defaultLoadSession,
  saveSessionFn: SessionStore["saveSession"] = defaultSaveSession
) {
  /** One refresh at a time per process: the refresh token is single-use, so two parallel calls would burn it. */
  let refreshInFlight: Promise<StoredSession | null> | null = null;

  /**
   * Trades the stored refresh token for a new access token and saves the new pair.
   * Returns the updated session, or null when the session cannot be renewed (no refresh token,
   * the server refused it, or the network failed). The stored refresh token is left alone on a
   * network failure so the next run can try again.
   */
  function refreshSession(session: StoredSession): Promise<StoredSession | null> {
    if (!session.refreshToken) return Promise.resolve(null);
    if (refreshInFlight) return refreshInFlight;
    const used = session.refreshToken;
    refreshInFlight = (async () => {
      try {
        const response = await netFetch("purix-api", `${baseUrl()}${API_ROUTES.refresh.path}`, {
          method: API_ROUTES.refresh.method,
          headers: { "content-type": "application/json", "X-Purix-Client-Version": PURIX_VERSION },
          body: JSON.stringify({ refreshToken: used }),
        });
        if (response.status === 409) {
          // Another purix process on this machine refreshed at the same moment and saved a newer pair.
          const latest = loadSessionFn();
          return latest && latest.refreshToken && latest.refreshToken !== used ? latest : null;
        }
        if (!response.ok) return null;
        const body = (await response.json()) as Partial<LoginResponse>;
        if (typeof body.token !== "string" || typeof body.refreshToken !== "string") return null;
        const fields = {
          refreshToken: body.refreshToken,
          expiresAt: body.expiresAt,
          refreshExpiresAt: body.refreshExpiresAt,
          sessionId: body.sessionId ?? session.sessionId,
        };
        saveSessionFn(body.token, session.email, fields);
        return { ...session, token: body.token, issuedAt: new Date().toISOString(), ...fields };
      } catch {
        return null;
      } finally {
        refreshInFlight = null;
      }
    })();
    return refreshInFlight;
  }

  async function request<T>(route: RouteSpec, init: RequestInit = {}, sessionOverride?: StoredSession): Promise<T> {
    /** True once this call has renewed the session ahead of time: a token that is still refused is not renewed again. */
    let renewedAhead = false;
    const path = route.path;
    const authenticated = route.authenticated;
    init = { method: route.method, ...init };
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "X-Purix-Client-Version": PURIX_VERSION,
      ...(init.headers as Record<string, string> | undefined),
    };

    let session: StoredSession | null = null;
    if (authenticated) {
      session = sessionOverride ?? loadSessionFn();
      if (!session) {
        throw new LoginRequiredError("Not logged in — run `purix login` first.");
      }
      // Renew before the token expires instead of paying a failed round trip for it. If the renewal does
      // not work (offline, refused) the call goes ahead with the token it has; the 401 path below is skipped
      // so a refused refresh token is not sent twice.
      if (!sessionOverride && shouldRefreshAhead(session)) {
        renewedAhead = true;
        const renewed = await refreshSession(session);
        if (renewed) session = renewed;
      }
      headers.authorization = `Bearer ${session.token}`;
    }

    let response: Response;
    try {
      response = await netFetch("purix-api", `${baseUrl()}${path}`, { ...init, headers });
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
      if (response.status === 401) {
        // A short-lived access token expires on its own. When a refresh token is stored, renew once and
        // repeat the call. A call that already used a renewed token is not renewed again.
        if (session && !sessionOverride && !renewedAhead && session.refreshToken) {
          const renewed = await refreshSession(session);
          if (renewed) return request<T>(route, init, renewed);
        }
        throw new LoginRequiredError(message);
      }
      if (response.status === 426) throw new ClientTooOldError(message);
      throw new ApiRequestError(response.status, message);
    }

    return (await response.json()) as T;
  }

  return {
    requestCode(email: string): Promise<void> {
      return request<void>(API_ROUTES.requestCode, { body: JSON.stringify({ email }) });
    },

    verifyCode(email: string, code: string, device?: DeviceIdentity): Promise<LoginResponse> {
      return request<LoginResponse>(API_ROUTES.verifyCode, {
        body: JSON.stringify(
          device ? { email, code, supportsRefresh: true, deviceId: device.deviceId, deviceName: device.deviceName } : { email, code }
        ),
      });
    },

    logout(): Promise<void> {
      return request<void>(API_ROUTES.logout);
    },

    getEntitlements(): Promise<EntitlementsResponse> {
      return request<EntitlementsResponse>(API_ROUTES.entitlements);
    },

    syncSavingsEvents(payload: SavingsEventPayload): Promise<{ ackedThroughSeq?: number }> {
      return request<{ ackedThroughSeq?: number }>(API_ROUTES.syncSavingsEvents, { body: JSON.stringify(payload) });
    },

    syncSavings(
      batches: { projectId: string; machineId: string; windowStart: string; totalSavingsUsd: number; callCount: number }[]
    ): Promise<void> {
      return request<void>(API_ROUTES.syncSavings, { body: JSON.stringify({ batches }) });
    },
  };
}

/** Real default instance — cli/commands/auth.ts and licensing/tier.ts use this. */
export const apiClient = createApiClient();
