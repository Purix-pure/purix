// packages/core/src/config/brand.ts
//
// WHY THIS FILE EXISTS:
// Everything a *person* reads (CLI banners, error messages, email
// templates, web page titles, support links) should come from here, not
// be typed as a literal string somewhere in the code. That way, when the
// domain and final name are locked in, changing the product's public
// identity is: (1) edit .env, (2) done. No code changes, no grep-and-pray
// across the codebase, no risk of missing a spot in a customer-facing
// email six months from now.
//
// This file does NOT cover identifiers a computer reads — the
// PURIX_* env var prefix, the .purix/ config folder, the @purix/*
// npm scope, or the `purix` CLI command itself. Those are structural,
// not cosmetic, and are handled once, deliberately, by
// scripts/rebrand.ts — see that file's header comment for why they
// can't just be env vars too.
//
// PLACEHOLDER NOTICE: every default below is "Purix" purely as a
// working placeholder chosen during pre-launch planning. Nothing here
// is a final decision — the actual name ships the day this file's
// env vars are set for real, driven by whatever domain gets purchased.

export interface BrandConfig {
  /** Display name shown in CLI banners, web UI, emails. */
  productName: string;
  /** Root domain, no protocol, no trailing slash — e.g. "purix.dev" */
  domain: string;
  /** Full marketing/docs site URL. */
  siteUrl: string;
  /** Full app/dashboard URL (may be a subdomain of `domain`). */
  appUrl: string;
  /** Support inbox shown in error messages and emails. */
  supportEmail: string;
  /** "From" address used by transactional email (Resend). */
  emailFrom: string;
  /** Public GitHub org/repo slug, e.g. "purix-dev/purix" — used to build links in CLI output. */
  githubRepo: string;
  /** X/Twitter or other primary social handle shown in CLI "star us" nudges, if any. */
  socialHandle: string | null;
}

const DEFAULTS: BrandConfig = {
  productName: "Purix",
  domain: "purix.example",
  siteUrl: "https://purix.example",
  appUrl: "https://app.purix.example",
  supportEmail: "support@purix.example",
  emailFrom: "Purix <noreply@purix.example>",
  githubRepo: "purix-dev/purix",
  socialHandle: null,
};

function env(key: string, fallback: string): string {
  const v = process.env[key];
  return v && v.trim().length > 0 ? v.trim() : fallback;
}

/**
 * Reads brand config from environment variables, falling back to the
 * placeholder defaults above. Call this once per process (e.g. at CLI
 * startup, at API server boot) rather than re-reading env everywhere.
 *
 * All env var names below use the BRAND_ prefix deliberately — this is
 * itself a "word a person configures," not a structural identifier, so
 * unlike PURIX_DEV_TIER etc. it's fine for it to stay BRAND_ forever
 * even after the product rename. Nothing downstream depends on the
 * literal string "BRAND".
 */
export function getBrandConfig(): BrandConfig {
  return {
    productName: env("BRAND_PRODUCT_NAME", DEFAULTS.productName),
    domain: env("BRAND_DOMAIN", DEFAULTS.domain),
    siteUrl: env("BRAND_SITE_URL", DEFAULTS.siteUrl),
    appUrl: env("BRAND_APP_URL", DEFAULTS.appUrl),
    supportEmail: env("BRAND_SUPPORT_EMAIL", DEFAULTS.supportEmail),
    emailFrom: env("BRAND_EMAIL_FROM", DEFAULTS.emailFrom),
    githubRepo: env("BRAND_GITHUB_REPO", DEFAULTS.githubRepo),
    socialHandle: process.env.BRAND_SOCIAL_HANDLE?.trim() || null,
  };
}

/**
 * Convenience singleton for call sites that just want the product name
 * inline (CLI help text, error messages) without threading config
 * through. Safe because brand values don't change mid-process.
 */
export const brand: BrandConfig = getBrandConfig();