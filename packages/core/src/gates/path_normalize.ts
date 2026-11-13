// packages/core/src/gates/path_normalize.ts
//
// A1 shared rail: one spelling for "the same path", so a rule written once matches however the path arrives.
//
// Why it exists (research 08 §floor probe, reproduced in the plan): the hook and the trust floor each compared raw strings, so
// `src\auth\login.ts` (a Windows agent) and `src/Auth/login.ts` (a case-insensitive disk) slipped past a rule written as
// `**/auth/**`. This function is the first half of the fix; path_match.ts is the second.
//
// What it does, in order:
//   1. Unicode NFC, so "é" typed two ways is one spelling (macOS hands out decomposed names).
//   2. Backslashes become "/". A Windows long-path prefix (\\?\) is dropped.
//   3. "." segments and doubled slashes are removed; ".." is resolved against the segment before it. A ".." with nothing before it
//      stays, so a path that climbs out of the repository is still visibly a climbing path (this function does not decide whether
//      that is allowed; gates/path_guard.ts does, against the real disk).
//   4. A trailing slash is dropped.
//   5. With `foldCase`, the whole path is lower-cased.
//   6. With `windowsNames`, trailing dots and spaces are dropped from each segment, because Windows opens `auth.` and `auth ` as
//      `auth`. Off by default: on Linux `auth.` is a different directory, and a caller that ALLOWS paths must not merge them.
//
// What it does NOT do, so no caller may rely on it:
//   - It never touches the disk: no symlink resolution, no existence check, and no case lookup of what is really stored.
//   - It cannot expand Windows 8.3 short names (PROGRA~1) or NTFS alternate data streams (file.ts:stream). A deny rule that needs
//     those must check the real path (hooks/decide.ts canonicalize does for symlinks; nothing does for 8.3 yet).
//   - Lower-casing is Unicode simple lower-casing, not a locale-aware or filesystem-aware fold. Turkish dotted I and similar
//     differences between a path as typed and as stored are not modelled.

export interface NormalizeRepoPathOptions {
  /** Lower-case the result. Use it when comparing; keep the default (off) when the result is shown to a person. */
  foldCase?: boolean;
  /** Strip trailing dots and spaces from every segment (the Windows rule). Default false. */
  windowsNames?: boolean;
}

export function normalizeRepoPath(path: string, opts: NormalizeRepoPathOptions = {}): string {
  let p = path.normalize("NFC").replace(/\\/g, "/");
  if (p.startsWith("//?/")) p = p.slice(4);

  const absolute = p.startsWith("/");
  const out: string[] = [];
  for (const raw of p.split("/")) {
    let seg = raw;
    if (opts.windowsNames && seg !== "." && seg !== "..") seg = seg.replace(/[. ]+$/, "");
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      const last = out[out.length - 1];
      if (last !== undefined && last !== "..") out.pop();
      else if (!absolute) out.push("..");
      continue;
    }
    out.push(seg);
  }

  let result = (absolute ? "/" : "") + out.join("/");
  if (result === "" && path !== "") result = absolute ? "/" : ".";
  return opts.foldCase ? result.toLowerCase() : result;
}

/** The comparison form: normalised and case-folded. Two paths with the same key are treated as the same path by every shared rule. */
export function repoPathKey(path: string, opts: Omit<NormalizeRepoPathOptions, "foldCase"> = {}): string {
  return normalizeRepoPath(path, { ...opts, foldCase: true });
}
