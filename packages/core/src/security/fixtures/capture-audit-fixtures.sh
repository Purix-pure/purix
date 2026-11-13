#!/usr/bin/env bash
# capture-audit-fixtures.sh: records what each package manager's audit command really prints, for audit/*.stdout and audit/*.meta.json.
#
# REWRITTEN 2026-11-07 (A15). The original script named in the N1 handoff was not in the repository. This one was rebuilt from the
# `tool`, `version` and `command` fields of the existing *.meta.json files and from the recorded outputs (the vulnerable package is
# lodash 4.17.15, the unreachable registry is 127.0.0.1:9). It was NOT the script that produced the recordings in the repository, and
# what was tried is at the bottom. Advisory data changes, so a re-recording of the *_vulnerable cases
# can differ from the stored one; the stored files are not touched unless you pass --write.
#
# Usage:  bash capture-audit-fixtures.sh [--write] [--dry-run] [--only <prefix>]   (prefix: npm10, pnpm10, pnpm11, yarn1, yarn4)
#   default: writes to a temporary folder and prints where. --write: writes into ./audit (overwrites the stored recordings).
# Needs: bash, node, npx and network access to the npm registry. Tools are fetched at the pinned versions with `npx -y`.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WRITE=0; DRY=0; ONLY=""
while [ $# -gt 0 ]; do case "$1" in --write) WRITE=1;; --dry-run) DRY=1;; --only) ONLY="${2:-}"; shift;; *) echo "unknown option $1" >&2; exit 2;; esac; shift; done
if [ "$WRITE" = 1 ]; then OUT="$HERE/audit"; else OUT="$(mktemp -d)"; fi
mkdir -p "$OUT"
VULN_VERSION="4.17.15"     # lodash with a known advisory (GHSA-35jh-r3h4-6jhm), as in the stored *_vulnerable recordings
# The clean probe is a different package: lodash 4.17.21 was tried and npm now reports an advisory for it (checked 2026-11-07), so it is not clean.
# is-number 7.0.0 came back with no advisories on npm 10.9.9 that day. The stored *_clean recordings show one dependency and none.
CLEAN_PKG="is-number"; CLEAN_VERSION="7.0.0"
DEAD_REGISTRY="http://127.0.0.1:9"

# name | tool runner | version | install command | audit command | scenario
CASES=(
  "npm10|npm|10.9.9"
  "pnpm10|pnpm|10.34.9"
  "pnpm11|pnpm|11.28.11"
  "yarn1|yarn|1.22.22"
  "yarn4|@yarnpkg/cli-dist|4.18.1"
)

run_tool() { # $1 pkg  $2 version  rest: args
  local pkg="$1" ver="$2"; shift 2
  if [ "$pkg" = "@yarnpkg/cli-dist" ]; then npx -y -p "@yarnpkg/cli-dist@$ver" yarn "$@"; else npx -y "$pkg@$ver" "$@"; fi
}

export -f run_tool

record() { # $1 case name  $2 tool label  $3 version  $4 command text  $5 exit code  $6 stdout file  $7 stderr file
  local name="$1" tool="$2" ver="$3" cmd="$4" code="$5" so="$6" se="$7"
  cp "$so" "$OUT/$name.stdout"
  node -e 'const fs=require("fs");const [n,t,v,c,x,so,se,out]=process.argv.slice(1);const e=fs.readFileSync(se,"utf8").split(/\r?\n/).find(l=>l.trim())||"";
    fs.writeFileSync(out+"/"+n+".meta.json",JSON.stringify({tool:t,version:v,command:c,exitCode:Number(x),stdoutBytes:fs.statSync(so).size,stderrFirstLine:e},null,2))' \
    "$name" "$tool" "$ver" "$cmd" "$code" "$so" "$se" "$OUT"
  echo "recorded $name (exit $code)"
}

for entry in "${CASES[@]}"; do
  IFS='|' read -r prefix pkg ver <<<"$entry"
  [ -n "$ONLY" ] && [ "$ONLY" != "$prefix" ] && continue
  tool="${pkg##*/}"; [ "$pkg" = "@yarnpkg/cli-dist" ] && tool="yarn"
  case "$prefix" in
    npm10)  audit=(audit --json);                    install=(install --package-lock-only --ignore-scripts); cmdtext="npm audit --json";;
    pnpm10|pnpm11) audit=(audit --json);             install=(install --lockfile-only --ignore-scripts);     cmdtext="pnpm audit --json";;
    yarn1)  audit=(audit --json);                    install=(install --ignore-scripts);                      cmdtext="yarn audit --json";;
    yarn4)  audit=(npm audit --json --no-deprecations); install=(install --mode=update-lockfile);              cmdtext="yarn npm audit --json --no-deprecations";;
  esac
  for scenario in clean vulnerable registry_unreachable $([ "$prefix" = yarn4 ] && echo old_command); do
    # the stored set has no pnpm11 registry_unreachable and no yarn1 registry_unreachable: skip what was never recorded
    if [ "$scenario" = registry_unreachable ] && { [ "$prefix" = pnpm11 ] || [ "$prefix" = yarn1 ]; }; then continue; fi
    name="${prefix}_${scenario}"
    if [ "$DRY" = 1 ]; then
      if [ "$scenario" = old_command ]; then echo "[dry-run] $name: install ${install[*]} ; run_tool $pkg $ver audit --json"; else echo "[dry-run] $name: install ${install[*]} ; run_tool $pkg $ver ${audit[*]}"; fi
      continue
    fi
    work="$(mktemp -d)"; so="$work/stdout"; se="$work/stderr"
    depname="$CLEAN_PKG"; dep="$CLEAN_VERSION"; [ "$scenario" = vulnerable ] && { depname="lodash"; dep="$VULN_VERSION"; }
    printf '{ "name": "audit-probe", "version": "1.0.0", "private": true, "dependencies": { "%s": "%s" } }\n' "$depname" "$dep" > "$work/package.json"
    ( cd "$work" && run_tool "$pkg" "$ver" "${install[@]}" >/dev/null 2>&1 )
    thiscmd="$cmdtext"; useaudit=("${audit[@]}")
    [ "$scenario" = old_command ] && { useaudit=(audit --json); thiscmd="yarn audit --json"; }
    envs=(PURIX_CAPTURE=1)
    if [ "$scenario" = registry_unreachable ]; then
      # npm and pnpm: the registry as a flag (the stored npm recording has the request-failed message this gives). yarn 4: the
      # setting by environment variable (the stored recording is yarn's "unsafe http" refusal, which this gives).
      case "$prefix" in npm10|pnpm10) useaudit+=(--registry "$DEAD_REGISTRY");; yarn4) envs+=(YARN_NPM_REGISTRY_SERVER="$DEAD_REGISTRY");; esac
    fi
    ( cd "$work" && env "${envs[@]}" bash -c 'run_tool "$@"' _ "$pkg" "$ver" "${useaudit[@]}" >"$so" 2>"$se" ); code=$?
    record "$name" "$tool" "$ver" "$thiscmd" "$code" "$so" "$se"
  done
done
echo "Output folder: $OUT"
# Tried (2026-11-07, Linux, real tools fetched with npx, real npm registry): all five tool versions were run, 14 recordings in total, written to a
# temporary folder and compared with the stored files. 13 of 14 stdout files were byte-identical to the stored ones (same exit codes);
# yarn4_vulnerable gave a 1,485-byte file against the stored 1,440 bytes, with the same advisories in a different line order or detail
# on the lines compared. Not tried: Windows, macOS, and a run with --write.
