// packages/core/src/cli-io/exit_codes.ts
//
// The one exit-code map for the Purix CLI (audit doc Purix 4, section 5).
// Code 2 is reserved for invalid usage, as command-line guidelines expect.
// CI scripts and `--json` output carry the same numbers and words.

export const EXIT = {
  OK: 0,
  CHECK_FAILED: 1, // `purix check` found a problem; also any ordinary failure
  USAGE: 2, // invalid usage (bad flag, unknown command)
  LOGIN_REQUIRED: 3, // server said 401, or no session
  CLIENT_TOO_OLD: 4, // server said 426
  INTEGRITY: 5, // audit chain or signature failure
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export const EXIT_WORDS: Record<ExitCode, string> = {
  0: "ok",
  1: "check_failed",
  2: "usage",
  3: "login_required",
  4: "client_too_old",
  5: "integrity",
};

/** Maps an error to its exit code by its `name`, so callers need no import cycle. */
export function exitCodeForError(err: unknown): ExitCode {
  const name = err instanceof Error ? err.name : "";
  if (name === "LoginRequiredError") return EXIT.LOGIN_REQUIRED;
  if (name === "ClientTooOldError") return EXIT.CLIENT_TOO_OLD;
  if (name === "IntegrityError") return EXIT.INTEGRITY;
  return EXIT.CHECK_FAILED;
}
