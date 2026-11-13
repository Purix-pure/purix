// packages/core/src/security/api_contract.ts
//
// The single list of every network route the client may call on
// purix-api, with its method and whether it needs a session. api_client.ts
// builds every request from this table, and api_contract.test.ts fails
// if api_client.ts names a path that is not listed here. The API side can
// import the same table in its validator (audit finding K7).
//
// Adding a route here is a deliberate act: it widens the one network door
// (net.ts purpose "purix-api"). Keep the list short.

export const DEFAULT_API_BASE_URL = "https://api.purix.dev";

export interface RouteSpec {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly authenticated: boolean;
}

export const API_ROUTES = {
  requestCode: { method: "POST", path: "/auth/request-code", authenticated: false },
  verifyCode: { method: "POST", path: "/auth/verify-code", authenticated: false },
  // The refresh token in the body is the credential, so no bearer token is sent. Single-use: every call returns a new one.
  refresh: { method: "POST", path: "/auth/refresh", authenticated: false },
  logout: { method: "POST", path: "/auth/logout", authenticated: true },
  entitlements: { method: "GET", path: "/entitlements", authenticated: true },
  syncSavings: { method: "POST", path: "/sync/savings", authenticated: true },
  // Event-ID savings sync (ADR-044 amendment). Server must be idempotent on (user, machineId, projectAlias, localSeq).
  syncSavingsEvents: { method: "POST", path: "/v1/sync/savings-events", authenticated: true },
} as const satisfies Record<string, RouteSpec>;

export type ApiRouteName = keyof typeof API_ROUTES;

export const API_ROUTE_PATHS: readonly string[] = Object.values(API_ROUTES).map((r) => r.path);
