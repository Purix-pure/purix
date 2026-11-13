# Domain research 01: sandboxing and isolation

## Verification update, 2026-10-31 (method v2)

**Status under method v2: Settled with gaps.** Pins: code `packages__2_.zip` d873c00c78b6822c; vault `purix-knowledge-working-2026-10-04.zip` 483002fb893b0085 (declared current by the owner on 2026-10-31, refresh after domain 16); Linux, Node 22.22.2; one run each. Full detail: `PURIX-RESEARCH-VERIFICATION-04-07-2026-10-31.md`. Probes: `research-verify-experiments/`. No finding below was deleted.

Not re-verified in this pass. It predates the method: no protocol file, no claims register, no experiment folder. Open items are unchanged (containers, microVMs, Windows Sandbox, cgroups, runner timeouts; the "code disagrees with ADR-002" finding against a current vault). Because the vault is now declared current, that ADR check can be done in the next pass.

Prepared 2026-10-17 from `packages.zip`, the `purix-knowledge` vault snapshot (ADR-002 and the plan files), and primary sources found today. This is the first domain document. It follows the second-edition AI research: for each concept, what Purix does now, what it should do, every option I found, the best way, and how we would know it worked. Nothing here is a plan or a priority list. It is the research that a plan would be built on.

## Consolidation notes, 2026-10-29

**Number and status.** Document 01. Status by the method's three words: **settled with gaps**. Code snapshot: `packages.zip` as uploaded on 2026-10-17; its hash was not recorded then. Statements were later spot-checked against `packages__2_.zip` (sha-256 d873c00c78b6822c) and held. 

**Evidence levels.** This document predates the evidence scale of `PURIX-RESEARCH-METHOD-2026-10-29.md`. Picks are not graded one by one yet. Until they are, read any pick that is not marked "measured" as level C or D: documented behaviour or reasoning, **not yet shown to improve results**. Five of its six primary sources were read as excerpts (its own source list says so).

**Unchecked, listed by the method review.** Containers, microVMs, Windows Sandbox, cgroups and test-runner timeouts were not examined; the Windows answer leans on software the document calls alpha; the vault is older than the code, so finding 1 ("code disagrees with ADR-002") must be re-checked against the current vault before anyone ratifies it. The experiment to close these is in the plan, step "Domain 01 refresh".

**Cross-references.** Where this document discusses the write step and rollback, `PURIX-RESEARCH-04` task 7 now holds the measured crash behaviour.

## Corrections made 2026-10-29 (from document 03)

Checked while writing `PURIX-RESEARCH-03` (details there, section 0).

1. Section 0, "already good": the secret scan before the copy is real, but it caught 9 of 22 synthetic tokens in a measured run and flagged 3 of 13 ordinary strings. It misses unquoted values, tokens containing a dot, hex keys and database URLs with passwords. Concept 1.1 option C and concept 5.2 rely on this scanner, so their limits are those of `PURIX-RESEARCH-03` task 4.
2. The sandbox links the project's existing `node_modules` and runs no install step, so a new dependency's install script cannot run during verification (read in `sandbox.ts`; I did not find an install call).

## Corrections made 2026-10-18

Checked against the code and the vault while writing `PURIX-RESEARCH-02`. Details and evidence are in section 9 of that document. The statements below are corrected in place and marked "(corrected)".

1. Concept 6.1: the real project is safe from the verification copy, not from the dependents cascade. The cascade compiles and tests dependents with the real project as working and writable folder (`verify/impact.ts` line 53; `verify/tests.ts` lines 228 and 276).
2. Section 1: ADR-002's amendment log is now read. It sets a provisional 2 GB memory ceiling per subprocess and a pre-commit latency target of P95 under 2 seconds. The code enforces neither.
3. Concept 3.1: no time limit is confirmed by experiment (a never-ending child did not return in 15 seconds).
4. Concept 3.2: the wrapper sets no `maxBuffer`, so Node's 1 MiB default applies. Above it, the call returns an error with the output dropped, and `verify/tests.ts` reports a failure.
5. Concept 8.2: the platform is checked before `which`, so `which` is never called on Windows, and `verify/tests.ts` prints a warning that names WSL2.
6. Concept 8.1: I count 45 test declarations across the nine files with a line-start pattern, not 56.
7. TypeScript's native compiler (version 7) was released 2026-08-03 (secondary report) and changes the cost side of concept 2.4.

## 0. Read this first

**What this domain is for.** Purix runs generated code (tests, a compiler, a style check) before it decides to touch your project. The sandbox is the part that makes that safe. It has two jobs that are easy to mix up:

1. **Protect the real project.** Purix already does this well, and not because of isolation. The real files are only ever written from the candidate content Purix holds in memory, never from the sandbox copy. Whatever a test does to the copy is thrown away. (Section 3, concept 6.1.)
2. **Protect your machine and your secrets** while generated code runs. This is where the sandbox is weak today, and it is what this document is mostly about.

**Eight findings that matter most.**

1. **The code does not do what ADR-002 decided.** ADR-002 says Windows gets a restricted token plus a Job Object, and that Purix must refuse to run when no isolation is available "rather than silently proceeding". The code does the opposite: on Windows it runs the command directly and prints a warning (`sandbox/sandbox_exec.ts`, last branch). ADR-002 also says to copy only the affected files. The code copies the whole project.
2. **On Windows, generated code and its tests run with your files and your network.** This is the platform you work on.
3. **I found no time limit on any sandboxed run.** A test that never ends would hang the verification. Node's `spawnSync` has `timeout`, `killSignal` and `maxBuffer` options, and Purix's wrapper does not appear to use them.
4. **TypeScript results are always labelled "no isolation", even on Linux with bubblewrap.** The TypeScript compile step is never isolated, and the sandbox takes the weakest label across all steps. The trust gate then refuses to auto-commit anything labelled "none". If the gate receives that label, as its input type says it should, no TypeScript change can auto-commit on any platform. That is safe but it is not what the label is meant to say, and it hides which step was actually unprotected.
5. **The environment filter is a name list.** `DATABASE_URL`, `AWS_ACCESS_KEY_ID` and similar names pass through. An allowlist is the safer shape.
6. **The copy only leaves out `.env` files.** Other credential files in the project are copied in.
7. **The sandbox's threat model is older than the product.** ADR-002 says its threat is a fix that is wrong or destructive by accident, not an adversarial source. Purix now accepts diffs from outside agents (`ingest`) and reads untrusted text, which makes deliberate attacks more plausible. ADR-002 names this as its revisit trigger.
8. **A maintained open-source option now covers all three platforms.** Anthropic's `sandbox-runtime` (Apache-2.0) uses the same primitives as Purix on Linux and macOS, and has a Windows backend, still alpha. It is also a research preview, with requirements that matter for Purix (concept 2.3).

**What is already good and should not be touched.** The refusal to fall back silently when bubblewrap is installed but cannot start. The Linux profile, which is stricter than Anthropic's default on reads (only `/usr`, `/bin`, `/lib` and the copy are visible, not the home folder). Network removed entirely on Linux and macOS. Secret scan and security gate before anything is copied. Real files only written from held candidate content. The isolation level travelling with the result.

## 1. How I worked, and what I could not check

**Read in the code:** `sandbox/sandbox.ts`, `sandbox_exec.ts`, `sandbox_env.ts`, `verify/verify.ts` (compile), `verify/tests.ts` (the isolated call and re-run), `language/provider-kit.ts`, `language/providers/typescript.ts` (lines 92 to 98), `recovery/resolve_verification.ts`, `gates/trustgate.ts`, `entrypoints/modify.ts`. From the vault: ADR-002 in full (the amendment log was read later; see the corrections above), and the plan references to Windows (PURIX-16 says Windows and macOS are untested).

**Primary sources:** Anthropic's `sandbox-runtime` README (read in full, current main branch); OpenAI's Codex Windows page (excerpt); Microsoft Learn Job Object structures (excerpts); the Node.js permission model and `child_process` pages (excerpts); the Linux kernel Landlock page (excerpts). Secondary sources are marked.

**Not done:** I did not run Purix, any test, or any sandbox. Everything about how the sandbox behaves on macOS or Windows is read from the code, not observed. I did not check: Docker or Podman, gVisor, Firecracker or other microVMs, Windows Sandbox, bubblewrap's own security notes, `prlimit`, cgroups or `systemd-run`, the timeout settings of Jest, Vitest, Mocha and pytest, or Apple's deprecation status for `sandbox-exec` (the code comment says deprecated, and Anthropic's runtime still uses it). Where a concept below depends on one of these, I say so.

## 2. What the sandbox is, today, in one paragraph

`verifyInSandbox` (`sandbox/sandbox.ts`) scans the candidate files for secrets, runs the security gate, and parses them. It then makes a temporary copy of the project (leaving out `.env`, `.env.*`, `node_modules`, `.git`, and Purix's state folder), links `node_modules` and installed tools back in, writes the candidate files into the copy, and for each language runs compile, tests and a style check. Tests go through `runIsolated` (`sandbox/sandbox_exec.ts`), which uses bubblewrap on Linux, `sandbox-exec` on macOS, and nothing on Windows or anywhere else. The compile step does not go through `runIsolated`. The copy is deleted afterwards. The result carries an isolation label: `network-namespace`, `os-sandbox` or `none`.

## 3. The tasks and their concepts

Eight tasks. Each concept has a number so you can refer to it.

---

## Task 1. Prepare the verification copy

### 1.1 What goes into the copy

**Today.** The whole project is copied, minus `.env`, `.env.*`, `node_modules`, `.git` and Purix's state folder. Every other file comes along, including any other credential file, and large build outputs or data folders if the project has them.

**What it should do.** ADR-002 said the copy holds only the files the check needs: the affected files from the dependency graph, plus lockfiles and the config the build tool needs. If verification needs something outside that set, fall back to a full copy for that run rather than report a false failure. It should never carry credential files.

| Option | Evidence | Weakness |
|---|---|---|
| A. Whole project minus a short exclusion list (today) | Simple; always has what the tests need | Slow on large repos; carries credentials; more to leak |
| B. Affected files plus lockfiles and config, falling back to A (ADR-002) | The vault decision; the dependency graph already exists for test-impact analysis | The fallback must be reliable, or false failures appear |
| C. Whole tree through hard links or copy-on-write | Fast to build | Hard links share content with the real file: a write through one changes the real file. Unsafe unless every file is read-only |
| D. A git worktree | Cheap, familiar | Carries `.git` data; does not carry uncommitted files, which is exactly what Purix verifies |
| E. Expose the real tree read-only and layer writes on top (overlay) | Fast; Linux has it | Windows and macOS have no equal; adds a platform-specific path |

**Best way.** B, with A as the fallback it already describes, and with the exclusion list from concept 5.2. The fallback must log why it happened, so the number of fallbacks can be tracked. C and E are faster but the speed gain is not needed yet and C is unsafe.

**How we would know.** Median copy size and copy time, share of runs that fell back to a full copy, and share of failures caused by a file missing from the partial copy. The last number must be near zero, or B is not ready.

### 1.2 What is linked back to the real project

**Today.** `node_modules` and the installed-tools folder are linked into the copy (symlink on Linux and macOS, junction on Windows). Linux and macOS give the sandboxed process read-only access to these real folders through the bind list.

**What it should do.** A link into the real project is a way back out of the copy. It must be read-only to the code under test, on every platform.

**The Windows problem.** With no isolation, nothing stops a test from writing through the junction into the real `node_modules` or the real tools folder. That changes files that the next verification, and your own build, will use. This follows from the code (junction plus no isolation); I did not run it.

| Option | Evidence | Weakness |
|---|---|---|
| A. Link (today) | Fast, no copy | Read-only only where the sandbox enforces it |
| B. Copy `node_modules` | Safe | Very large, slow, and native modules can break when copied |
| C. Link, then verify the link target's hash tree is unchanged after the run | Detects tampering | Detects after the fact; hashing `node_modules` is slow |
| D. Link only where the backend enforces read-only; otherwise refuse (concept 2.5) | Honest | Fewer machines can verify |

**Best way.** A where the backend enforces read-only, and a refusal to run tests on a backend that cannot (D). On Windows that means nothing runs until concept 2.3 is solved.

**How we would know.** The conformance suite (concept 8.1) includes "write through the dependency link". It must fail to change the real file on every platform.

### 1.3 Cleaning up the copy

**Today.** Every copy is tracked and removed in a `finally` block. On Ctrl+C the CLI's single signal handler calls `cleanupSandboxTempRoots`. A hard kill leaves `purix-verify-*` folders in the system temp folder.

**What it should do.** Leave nothing behind, including after a crash.

| Option | Weakness |
|---|---|
| A. `finally` plus signal handler (today) | A killed process leaves folders |
| B. A + a startup sweep of old `purix-verify-*` folders (older than a day, not locked) | Needs a safe "is it in use" test |

**Best way.** B. It is a small addition, and the folders can hold a project copy.

**How we would know.** After a deliberate `kill -9` mid-run, the next run removes the leftover.

---

## Task 2. Choose and apply the isolation boundary

### 2.1 Linux

**Today.** Bubblewrap with: read-only `/usr`, `/bin`, `/lib`, `/lib64`; a fresh `/dev`, `/proc` and `/tmp`; the copy writable; the network namespace removed (`--unshare-net`); a new PID namespace; `--die-with-parent`. If bubblewrap is on `PATH` but cannot start, Purix throws and stops.

**What it should do.** Keep all of that. Anthropic's runtime adds things this profile lacks: a seccomp filter that blocks creating new user namespaces and Unix sockets from inside the sandbox, and mandatory write-protection for files such as shell rc files, `.git/hooks` and `.mcp.json`. The first matters because a sandboxed process that can create its own user namespace can undo the mounts that protect it, which the runtime's own documentation describes in detail.

| Option | Evidence | Weakness |
|---|---|---|
| A. Bubblewrap as it is | Built and consistent with ADR-002 | No seccomp, so nested namespaces are not blocked. Does not work where user namespaces are blocked (default Docker) |
| B. Bubblewrap plus a seccomp filter | The runtime ships a prebuilt filter for x86-64 and arm | Needs a compiled helper per architecture |
| C. Landlock (kernel feature, no namespaces) | Kernel documentation: any unprivileged process can restrict itself, filesystem rules from the start, TCP port rules since ABI v4. It degrades by ABI version | Needs a small native helper to call it; Node cannot |
| D. A container (Docker or Podman) | ADR-002 rejected it: a heavy dependency for a CLI | Not researched here |
| E. A microVM (gVisor, Firecracker) | Strongest boundary | Not researched here; heaviest to ship |
| F. Anthropic's sandbox runtime as a dependency | Same primitives, maintained, Apache-2.0, adds seccomp and mandatory denies | Research preview; needs `socat` and `ripgrep` on Linux; on Ubuntu 24.04 and later an AppArmor setting must be relaxed, and a root caller needs `CAP_SETFCAP` (all from its README) |

**Best way.** Keep A now. Add B's seccomp filter by taking the runtime as a library behind Purix's existing `runIsolated` signature (F), because Purix's one-function front door already has the right shape for a backend swap. C is the answer for the Docker case (where A cannot start), but needs a helper binary, so it is a later addition. D and E need their own research pass.

**How we would know.** The conformance suite (8.1) on Linux: all escape attempts blocked, including "create a nested user namespace" and "connect to a Unix socket".

### 2.2 macOS

**Today.** `sandbox-exec` with a generated profile: default deny, read allowed only for a short list of system folders plus the copy, writes only to the copy, no network. The vault says macOS is untested (PURIX-16).

**What it should do.** Work, and be tested. I cannot confirm from reading that the profile lets the target program start, since it allows `process-fork` but I did not see an allowance for running binaries, and some toolchains write caches to places the profile does not allow. Both would show up as failures on first real use.

| Option | Evidence | Weakness |
|---|---|---|
| A. `sandbox-exec` profile (today) | Same primitive Anthropic's runtime uses on macOS | Apple marks the tool deprecated (per the code comment; not re-checked) |
| B. Anthropic's runtime as the backend | Maintained profile generation, violation log, tested on macOS | Same dependency questions as 2.1 F |
| C. A native App Sandbox entitlement | Apple's supported route | Needs a signed app, not a CLI |

**Best way.** B once the Linux decision is made, because one dependency then serves both. Until then A stays, and macOS verification is labelled untested.

**How we would know.** Conformance suite on a macOS runner. The first run is the real test, and I expect it to find profile gaps.

### 2.3 Windows

**Today.** No isolation. `runIsolated` falls to its last branch, runs the command directly, and returns `isolation: "none"`. `verify/tests.ts` prints a warning that names WSL2 as the way out.

**What it should do.** ADR-002 says: a restricted token plus a Job Object, and refuse to run if neither can be applied.

**What other tools do on Windows.**

- **OpenAI Codex** has two native modes (primary documentation). The preferred "elevated" mode uses dedicated lower-privilege sandbox users, filesystem permissions, and Windows Firewall rules, and needs an administrator approval once. The fallback "unelevated" mode uses a restricted token derived from your own user with filesystem ACLs, and only an environment flag for "offline", which a program can ignore. Codex also supports running inside WSL2, which uses its Linux sandbox. Detailed descriptions come from secondary write-ups; the documentation page confirms the two modes.
- **Anthropic's sandbox runtime** has an alpha Windows backend (its own README). It runs the process under a dedicated `srt-sandbox` local user, blocks outbound network for that user with Windows Filtering Platform rules (loopback to its proxy only), and grants file access with explicit ACLs. A one-time elevated install is required. Its listed limits include: tools installed per user (nvm, Scoop, `pip --user`) cannot be opened by the sandbox account, DNS lookups are not blocked, and certificate-revocation checks fail under strict schannel clients.
- **Job Objects** (Microsoft documentation) limit resources, not access. They can cap committed memory per process and per job, cap the number of active processes, cap CPU time, and kill all processes when the job closes. They do not restrict files or network.

| Option | What it gives | Weakness |
|---|---|---|
| A. None, with a warning (today) | Works everywhere | Code runs with your files and network |
| B. Refuse to run generated code without isolation (ADR-002's text) | Honest, matches the vault | No verification on Windows until another option exists |
| C. Delegate to WSL2 and use bubblewrap there (IDEA-063) | Reuses the Linux path | A Windows project's native modules, line endings and paths may not behave the same in Linux; the project must be reachable from WSL; slow across the Windows/Linux file boundary. Anthropic's README notes WSL 2 mounts of Windows drives report permissions Linux cannot trust |
| D. Build a native restricted-token sandbox in Purix (Codex-style) | Full control | A native helper to write, sign and maintain; Node cannot call these APIs directly |
| E. Anthropic's runtime Windows backend | Maintained, covers files and network | Alpha; per-user tool installs unreachable; one-time elevated install |
| F. Job Object limits only | Time, memory and process caps | No file or network protection; needs a native helper to create |
| G. Node's permission model | Cross-platform; restricts file reads and writes and child process creation for the Node process | The documentation calls it a "seat belt" for trusted code, not a boundary against malicious code. Fits only Node-run tests, and the documentation says the file module bypass and subprocess behaviour need care |
| H. Windows Sandbox or a Hyper-V container | A whole-VM boundary | Not researched here; edition requirements and start-up cost unknown |

**Best way.** A staged answer, because no single option is both strong and available today:

1. **Now:** B. Refuse to run tests on Windows unless the person opts in once per project, and say clearly what that opt-in means. Static checks (parse, compile) still run, and the result says "tests not run". This is what ADR-002 already decided, and it fits Purix's existing "not tested is never a pass" rule.
2. **Next:** E behind the same `runIsolated` front door, behind a setting, with D's conformance suite deciding whether it is ready. Check first that Purix's tool broker installs tools somewhere the sandbox account can read (the README's per-user limitation is exactly the shape of Purix's `.purix/tools` folder if the project lives under a user profile).
3. **Where a project already lives in WSL2:** C. Do not make it the Windows default.
4. **Accident guard for Node tests (G) plus Job Object limits (F):** only as a labelled weaker tier (`process-guard`), never as `isolated`.

**How we would know.** The conformance suite on a Windows runner. Option E is ready when every attempt is blocked and the project's real tests still pass inside it.

### 2.4 The compile step

**Today.** `verify/verify.ts` runs `tsc` directly with no isolation and returns `isolation: "none"`. The TypeScript provider's `verify` calls it. Other languages' compile steps go through the provider kit's `runIsolated`.

**What it should do.** Either run isolated like the rest, or be labelled for what it is. The TypeScript compiler does not run project code, so "static analysis, nothing executed" is a true description. "No isolation" is a true description too, and the two lead to different conclusions.

| Option | Weakness |
|---|---|
| A. Direct run, labelled `none` (today) | The label drags the whole result to `none` |
| B. Route through `runIsolated` | The compiler and `tsconfig` paths must be readable inside the sandbox |
| C. Direct run, labelled `static`, never counted against the isolation of the test step | Needs a new label and a gate rule that understands it |

**Best way.** B where the backend works (Linux, macOS), C elsewhere. Report each step's label separately in the result, instead of keeping only the weakest. That also makes the trust gate's reason accurate.

**How we would know.** A TypeScript change verified on Linux with bubblewrap reports `network-namespace` for tests and the compile step's own label, and the trust gate can auto-commit it.

### 2.5 When no boundary can start

**Today.** Linux with bubblewrap installed but unable to start: error and stop (good). No bubblewrap, macOS without `sandbox-exec`, any Windows: run unisolated and warn (conflicts with ADR-002).

**What it should do.** One rule, applied the same on every platform: if the required boundary is not available, do not run generated code, unless the person has explicitly allowed it for this project.

| Option | Weakness |
|---|---|
| A. Warn and run (today, outside the bubblewrap-error case) | Harm happens before the warning is read |
| B. Refuse (ADR-002) | Some machines cannot verify |
| C. Ask each time | Prompt fatigue. Anthropic reports people approve about 93% of permission prompts (figure from your earlier research; I did not re-check the source) |
| D. Refuse by default, with a per-project opt-in written to config, shown in `purix status`, recorded in the audit chain | Slightly more setup |

**Best way.** D.

**How we would know.** A test run on a machine without any backend does not execute project code, and says why.

---

## Task 3. Limit time and resources

### 3.1 Wall-clock limit and killing the whole process tree

**Today.** I found no timeout in `platform/spawn_sync.ts`, `verify/tests.ts` or `sandbox_exec.ts`. Confirmed by experiment on 2026-10-18: a never-ending child did not return within 15 seconds. ADR-002's amendment log also decided a provisional 2 GB memory ceiling, which the code does not enforce.

**What it should do.** A run has a maximum time. When it expires, the process and everything it started die, and the result says "timed out", which is a different failure from "tests failed".

**What the documentation says.** Node's `spawnSync` takes `timeout`, `killSignal` (default `SIGTERM`) and `maxBuffer`. After a timeout it does not return until the process has completely exited, so a child that ignores `SIGTERM` makes the parent wait indefinitely. Use `SIGKILL`. On Windows, killing the direct child does not kill its children, and a tree kill needs `taskkill /T` (I found this in a code comment in another open-source project, not in Node's own documentation, so treat it as secondary).

| Option | Evidence | Weakness |
|---|---|---|
| A. No limit (today) | None | One bad test hangs everything |
| B. `timeout` and `killSignal: "SIGKILL"` on the spawn call | Node documentation | Does not kill grandchildren on Windows or macOS |
| C. B plus a tree kill on timeout (`taskkill /T /F`; process-group kill on POSIX) | Secondary | More platform code |
| D. B on Linux, relying on `--unshare-pid` and `--die-with-parent` to remove the whole tree | Already in Purix's bubblewrap arguments | Only Linux |
| E. The test runner's own per-test timeout as well | General knowledge, not checked here | Covers one test, not a hung process |

**Best way.** B everywhere, D on Linux, C on Windows and macOS, and E left on whatever the project already configures. The total limit starts as a measured number, not a guess: record the duration of every passing run in the event log, set the ceiling at about three times the 95th percentile for that project, and use a fixed default (I would start at five minutes) until there is data.

**How we would know.** The conformance suite's "infinite loop" and "sleeps forever in a grandchild" attempts: the run returns in time and no process is left behind.

### 3.2 Memory, process count, output size

**Today.** None that I found, other than what bubblewrap or the OS applies by default. The wrapper sets no `maxBuffer`, so Node's 1 MiB default applies; measured on 2026-10-18, output above that returns an error with the output dropped, and `verify/tests.ts` reports a failure (corrected).

**What it should do.** Cap memory, the number of processes, and captured output, so a runaway test fails quickly instead of freezing the machine.

| Option | Evidence | Weakness |
|---|---|---|
| A. None (today) | None | A fork bomb or memory hog takes the machine |
| B. Job Object limits on Windows | Microsoft documentation: process and job memory limits, active-process limit, CPU-time limit, kill on close | Node cannot create job objects without a native helper; Anthropic's Windows backend already runs the target inside one |
| C. `prlimit`, cgroups or `systemd-run` on Linux | Not researched here | Availability varies; cgroups often need privileges |
| D. A `maxBuffer` on the spawn call | Node documentation | Caps output only |
| E. Rely on a microVM or container for limits | Not researched here | Heavy |

**Best way.** D everywhere now (it is one argument). B comes with the Windows backend. For Linux, research C properly before choosing, because the right answer depends on whether bubblewrap's user-namespace setup allows it without root.

**How we would know.** The "allocate 4 GB", "fork bomb" and "print 100 MB" attempts end with a resource failure, within the time limit, and the machine stays responsive.

---

## Task 4. Control the network

### 4.1 No network while generated code runs

**Today.** Linux: network namespace removed. macOS: profile denies `network*`. Windows: nothing.

**What it should do.** Deny all network on every platform, because generated code that can reach the network can send your files out.

| Option | Evidence | Weakness |
|---|---|---|
| A. Namespace or profile deny (today on Linux and macOS) | Same as Anthropic's runtime on those platforms | None on those platforms |
| B. Firewall rules keyed to a sandbox user (Windows) | Codex "elevated" mode and Anthropic's Windows backend | Needs an administrator step once |
| C. An environment flag that says "offline" | Codex "unelevated" mode does this | Cooperative only; a program can ignore it |
| D. An allowlist proxy (domains) | Anthropic's runtime; allow-only by default | A proxy to run and a policy to maintain, which verification does not need |

**Best way.** A, and B on Windows through concept 2.3. Do not use C as the only control; label it `process-guard` at best. D is not needed for verification.

**How we would know.** The "connect to a listener the parent opened outside the sandbox" attempt must fail on every platform.

### 4.2 Tests that need the network

**Today.** Such a test fails with an error like "connection refused" or "host not found", the repair loop is told it is a failure, and a model is asked to fix the code.

**What it should do.** Tell a failure caused by missing network apart from a real failure, so repair is not wasted on it.

| Option | Weakness |
|---|---|
| A. Treat as any failure (today) | Wastes repair calls and invites the model to remove or mock the test |
| B. Recognise the standard network error codes and report "needs network", skip repair, and surface it to the person | Pattern list to maintain |
| C. Allow the network for such tests through an allowlist proxy | Opens the hole the sandbox exists to close |

**Best way.** B. It matches how Purix already treats policy blocks.

**How we would know.** Share of repair rounds caused by network errors drops to zero.

---

## Task 5. Control secrets and the environment

### 5.1 Environment variables

**Today.** The child gets the parent's environment minus any variable whose name contains `API_KEY`, `SECRET`, `TOKEN`, `PASSWORD` or `CREDENTIAL`. `DATABASE_URL`, `AWS_ACCESS_KEY_ID` and other credential-bearing names pass through.

**What it should do.** Pass only what the toolchain needs.

| Option | Evidence | Weakness |
|---|---|---|
| A. Remove names that look secret (today) | Simple | Any name not on the list leaks |
| B. Pass an allowlist: `PATH`, temp and home folders pointing at the copy, locale, `CI`, `NODE_ENV`, and per-toolchain additions that each language provider declares | Anthropic's Windows backend does this: a fresh environment with only `PATH` and the proxy variables | A missing variable breaks a tool until the provider adds it |
| C. A with an added scan of values for known token formats | Catches renamed secrets | Pattern list; false positives |
| D. Anthropic's runtime credential handling: deny a variable, or replace it with a placeholder that is only swapped back on egress to listed hosts | Its README | Needs a proxy; verification has no egress |

**Best way.** B, with C as an extra check that reports instead of blocking. Provider declarations keep the allowlist per language rather than one global list.

**How we would know.** The conformance suite sets `DATABASE_URL`, `AWS_ACCESS_KEY_ID`, and a variable with a made-up name holding a real token format. A test that prints its environment shows only allowed variables.

### 5.2 Credential files inside the copy

**Today.** Only `.env` and `.env.*` are left out.

**What it should do.** Leave out files that hold credentials, and say so.

| Option | Weakness |
|---|---|
| A. `.env` only (today) | Everything else is copied |
| B. A name list: `.npmrc`, `.pypirc`, `.netrc`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `.aws/`, `.ssh/`, `.docker/config.json`, `*.tfvars`, `credentials*.json` | A name list is incomplete |
| C. Run Purix's own secret scanner over the tree and leave out any file with a hit | Slow on a large tree; uses the same scanner whose limits are domain 1's |
| D. Make files unreadable inside the sandbox instead of leaving them out (Anthropic's `denyRead`) | Platform-specific; some platforms cannot do it for files |

**Best way.** B plus C, with the excluded paths listed in the run's record. A test that fails because a needed file was left out gets a clear class ("excluded for safety"), not a mystery.

**How we would know.** A planted `.npmrc` and `id_rsa` in a test project are absent from the copy, and the run record names them.

### 5.3 Reads outside the project

**Today.** Linux and macOS: only the system folders and the copy are visible, so the home folder (`~/.ssh`, cloud credentials) is not readable. Windows: everything the user can read.

**What it should do.** Keep the Linux and macOS behaviour. Anthropic's runtime defaults to allowing reads everywhere except listed paths, which is weaker than Purix's Linux profile, so Purix should not adopt that default if it switches to the runtime. It should set a read allowlist.

**Best way.** Keep it. On Windows it follows concept 2.3.

**How we would know.** The "read a planted file in the home folder" attempt fails on every platform.

---

## Task 6. Control writes

### 6.1 What the code under test may write

**Today.** Linux: only the copy and a temporary `/tmp`. macOS: only the copy. Windows: anywhere the user can write. The copy is thrown away after the run, and the real project only receives the candidate content Purix held before the sandbox ran (`modify.ts` writes `finalFiles`, not the copy).

**Why that matters.** A test that edits `package.json`, a source file, or a script inside the copy cannot change the real project. The only routes to the real project from inside the sandbox are the linked folders (concept 1.2) and, on Windows, ordinary file access. So write isolation matters most for those, and for anything outside the project.

**What it should do.** Allow writes to the copy and a temp folder, nothing else. On the copy, consider protecting files whose change would help an attack on the next step, such as shell rc files and `.git/hooks`, which Anthropic's runtime blocks always. Purix's copy leaves out `.git`, so the main case does not apply.

**Best way.** Keep the current Linux and macOS behaviour; the Windows part follows concept 2.3. Say in the documentation that the real tree is safe from the verification copy because of the write path, not because of the sandbox, so nobody weakens that path later. (Corrected: this does not hold for the dependents cascade, which runs compile and tests with the real project as working and writable folder, `verify/impact.ts` line 53 and `verify/tests.ts` lines 228 and 276. On Linux with bubblewrap that folder is writable to the test code. The cascade should run in a copy or overlay like the first verification. Read from the code; bubblewrap was not run.)

**How we would know.** A test that overwrites a source file in the copy leaves the real file unchanged. A test that writes a file in the home folder fails on Linux and macOS.

---

## Task 7. Report isolation honestly and act on it

### 7.1 The isolation label

**Today.** Three values. `none` always wins when results are combined. Because the TypeScript compile step is always `none` (concept 2.4), a TypeScript result is `none` even when the tests ran under bubblewrap.

**What it should do.** Say which step ran under which boundary, so the gate, the person and the audit record can each use the part they need.

| Option | Weakness |
|---|---|
| A. One label, weakest wins (today) | Hides which step was weak |
| B. A label per step: compile, tests, style check | The gate must define a rule over several labels |
| C. One label plus the list of steps that dragged it down | Easiest to add; the label still says `none` |

**Best way.** B, with the trust gate reading the test step's label and treating the compile step as static (concept 2.4). Keep the single summary label for display.

**How we would know.** A change verified on Linux under bubblewrap shows `tests: network-namespace` and the gate's reason names the right step.

### 7.2 What the gate does with the label

**Today.** `evaluateTrustGate` asks a person before committing when confidence is high but isolation is `none`. By then the code has already run. (Section 5 of `PURIX-RESEARCH-00`.)

**What it should do.** Act before running, not after. Concept 2.5 does that. The gate rule stays as a second layer, because a label can still be `none` through an explicit opt-in.

**Best way.** Keep the rule, add concept 2.5's refusal in front of it.

**How we would know.** With no backend and no opt-in, the gate is never reached for a test run, because no test ran.

---

## Task 8. Prove the sandbox works

### 8.1 A fixed set of escape attempts, run on every platform

**Today.** The `sandbox/` folder has about 45 test cases across nine files (corrected from 56; I count declarations with a line-start pattern), covering the copy, the environment filter, the argument lists for each platform, and error handling. A keyword search of those files for escape, timeout, fork-bomb and credential-reading cases found none, so I found no test that runs a hostile program against the real boundary. I did not run them. The vault says Windows and macOS are untested.

**What it should do.** A conformance suite: small programs that try to break out, run through `runIsolated` on each platform's CI runner, with the expected result written down.

| Attempt | Expected |
|---|---|
| Write a file outside the copy (home, `C:\`, `/etc`) | Blocked |
| Read a planted file in the home folder | Blocked (Linux, macOS, Windows backend) |
| Print the environment | Only allowed variables |
| Open a connection to a listener outside the sandbox | Blocked |
| Resolve a hostname | Fails or is reported (Anthropic notes Windows cannot fence DNS) |
| Spawn a detached child that outlives the run | Killed at the end |
| Infinite loop and a grandchild that sleeps forever | Killed at the time limit |
| Allocate 4 GB; fork bomb | Resource failure, machine stays up |
| Print 100 MB | Output capped |
| Create a nested user namespace; connect to a Unix socket (Linux) | Blocked |
| Write through the linked `node_modules` or tools folder | Real folder unchanged |
| Follow a symlink in the copy that points outside | Blocked |

Anthropic's runtime ships its own test suite and CI across architectures, and Codex has a `doctor` command that reports Windows sandbox state (the latter from a secondary source), so this practice has precedent.

**Best way.** Build the suite once, run it on Linux, macOS and Windows runners, and make "all attempts blocked" the definition of an isolated label on that platform. It becomes the objective test for concepts 2.1 to 2.3, and for choosing between backends.

**How we would know.** The suite exists, runs in CI per platform, and a backend whose results change fails the build.

### 8.2 Telling the truth about what is available

**Today.** Bubblewrap is detected by running `which bwrap`, and a real start-up failure is caught later and reported (good). (Corrected: the code checks the platform first, so `which` is never called on Windows, and `verify/tests.ts` prints a warning that names WSL2. The earlier wording, that detection fails silently, was wrong.)

**What it should do.** `purix status` should state the backend that would be used on this machine, found by a real trial run (a tiny command through the boundary), and what it protects against.

**Best way.** A start-up trial run, cached per session, shown in `purix status` and in the verification result.

**How we would know.** On a machine with no backend, `purix status` says so in one line, before any verification starts.

---

## 4. How the picks fit together

One front door, `runIsolated`, with an ordered list of backends per platform, each reporting an honest label. A single rule above it: if the needed boundary is not available, do not run generated code unless this project opted in. Limits (time, output, and memory where the backend can) wrapped around every backend. A conformance suite that defines what each label means.

| Platform | Backend order | What generated code can reach |
|---|---|---|
| Linux | bubblewrap (now); add seccomp through the runtime; Landlock helper later for Docker | Copy only; no network |
| macOS | `sandbox-exec` (now, untested); the runtime once chosen | Copy only; no network |
| Windows | Refuse tests unless opted in (now); runtime's Windows backend when it passes the suite; WSL2 for projects that live there | Today: everything |

## 5. What this document did not settle

- **Containers and microVMs** (Docker, Podman, gVisor, Firecracker) and **Windows Sandbox**: only ADR-002's reasons for rejecting containers are known. A separate pass is needed.
- **Resource limits on Linux** (cgroups, `prlimit`): the right choice depends on what works without root under bubblewrap.
- **Whether Anthropic's runtime can be a dependency of a published npm package** with a Windows backend still alpha, its license (Apache-2.0, which fits), and its install requirements on user machines.
- **macOS behaviour.** Everything here is from reading the code.
- **The test-runner timeouts** of Jest, Vitest, Mocha and pytest.

## 6. Sources

**Primary**
- Anthropic, `sandbox-runtime` README, `github.com/anthropics/sandbox-runtime` (read in full; research preview; Windows alpha).
- Anthropic, Claude Code "Choose a sandbox environment", `code.claude.com/docs/en/sandbox-environments` (excerpt).
- OpenAI, Codex on Windows, `developers.openai.com/codex/windows` (excerpt): elevated and unelevated modes, WSL2.
- Microsoft Learn, `JOBOBJECT_BASIC_LIMIT_INFORMATION`, `JOBOBJECT_EXTENDED_LIMIT_INFORMATION` (excerpts).
- Node.js documentation, Permission Model and `child_process.spawnSync` (excerpts).
- Linux kernel documentation, "Landlock: unprivileged access control" (excerpts).
- Purix vault, ADR-002 and the plan files; Purix source code in `packages.zip`.

**Secondary (used only to point at things to verify)**
- Third-party write-ups of the Codex Windows sandbox internals (`codex.danielvaughan.com`).
- An open-source script's comments on Windows process-tree termination.
- A .NET source file showing the job-object kill-on-close flag.
