# Review: Developer ID signing + notarization pipeline (PR #48)

- **Date:** 2026-09-20
- **Reviewer:** Independent Reviewer (mandatory review, AGENTS.md §3)
- **Branch/Worktree:** `chore/developer-id-signing` — `.worktrees/developer-id-signing` (diff `main...HEAD`, commits `a32ed3c`, `d7a9209`)
- **PR:** https://github.com/n0tnow/StellarVoiceControlProject/pull/48
- **Verdict:** **APPROVE WITH CHANGES**

---

## Scope Reviewed

Full `main...HEAD` diff, 8 files, +325/-5:

| File | Reviewed for |
|---|---|
| `scripts/release-macos.sh` (new, 173 lines) | codesign/notarization correctness, bash 3.2 compatibility, failure modes |
| `app/src-tauri/Entitlements.plist` (new) | sufficiency for `cpal` + `SFSpeechRecognizer` + WKWebView under Hardened Runtime |
| `app/src-tauri/tauri.conf.json` | `hardenedRuntime` / `entitlements` / version |
| `docs/release-macos.md` (new) | drift against the script's actual behaviour |
| `Makefile`, `VERSION`, `CHANGELOG.md`, `README.md` | version-bump completeness, conventions |

Checks actually executed (not merely read):

- `bash -n scripts/release-macos.sh` — clean.
- `/bin/bash --version` → **3.2.57**. Verified `for arg in "$@"` with `set -euo pipefail` and zero
  positional parameters survives on 3.2.57 (the classic pre-4.4 `$@`/nounset trap does **not** bite here).
  No `mapfile`, no associative arrays, no `${var,,}`, no `&>>`. Confirmed bash-3.2 clean.
- `shellcheck` — **not installed on this machine**; could not run. `bash -n` is the only static check performed.
- `plutil -lint app/src-tauri/Entitlements.plist app/src-tauri/Info.plist` — both OK.
- Reproduced the `find` traversal order of the nested-signing loop against a synthetic
  `Foo.framework/Versions/A/libinner.dylib` (see MINOR-1).
- Verified experimentally that `codesign --entitlements <plist> <dylib>` succeeds but **silently drops**
  the entitlements (see NIT-1).
- Inspected the built bundle at `app/src-tauri/target/release/bundle/macos/Autonomy.app`:
  `codesign -dvv` reports `flags=0x10002(adhoc,runtime)`, `TeamIdentifier=not set` — i.e. the current
  local artifact is still the ad-hoc one this PR exists to replace, as the PR honestly states.
- Version grep across the repo, and `PlistBuddy` on the built `Info.plist`.

**The signing path has not been executed end to end** — no `Developer ID Application` certificate is
installed on this machine. Every conclusion below about codesign/notarytool/spctl behaviour comes from
reading the script against the documented macOS rules, not from a real run. That limitation is stated
plainly in the PR description and is the right call; it is also why this review is deliberately pedantic.

---

## Confirmed Correct

These were explicitly checked and are right — listing them so a later reader does not re-litigate them:

- **Staple order.** The app is notarized (`scripts/release-macos.sh:130-131`), stapled
  (`:132`), and only then `ditto`'d into the DMG staging directory (`:139`). The copy inside the
  disk image carries the ticket. This is the ordering that matters and the script gets it right.
- **DMG signed without entitlements or `--options runtime`** (`scripts/release-macos.sh:145`).
  Correct: a disk image is not executable code; Hardened Runtime and entitlements are meaningless on it
  and asking for them is a common way to get a confusing notarization failure.
- **`spctl` invocations.** `--type execute` for the `.app` (`:160`) and
  `--type open --context context:primary-signature` for the `.dmg` (`:161`) are the two documented
  forms. Using `--type execute` on a DMG (a frequent mistake) would report a bogus rejection.
- **`hdiutil create -format UDZO`** (`:142-143`) produces a read-only compressed UDIF image, which is
  a format `codesign`, `notarytool` and `stapler` all accept. (`UDRW`/sparse images are not staplable.)
- **`--options runtime` and `--timestamp`** are present on every code-signing call
  (`:105` for nested and for the bundle) and correctly absent from the DMG signing call.
- **`ditto -c -k --keepParent`** (`:129`) is the correct archiver for notarization submission —
  `zip(1)` loses symlinks and extended attributes and produces submissions Apple rejects.
- **Entitlements content is right and sufficient.** For a non-sandboxed, hardened-runtime app:
  - `com.apple.security.device.audio-input` is the correct and only entitlement needed for `cpal`
    microphone capture. `Info.plist` already carries `NSMicrophoneUsageDescription`
    (`app/src-tauri/Info.plist:8`), which is the TCC prompt string, not a substitute — the doc says
    exactly this (`docs/release-macos.md:96-98`) and is correct.
  - **`SFSpeechRecognizer` needs no entitlement.** On-device speech recognition
    (`app/src-tauri/src/stt.rs:9,640`) is gated by TCC plus `NSSpeechRecognitionUsageDescription`,
    which is present (`app/src-tauri/Info.plist:13`). Nothing is missing here.
  - **Tauri/WKWebView needs no JIT entitlement.** WebKit's JIT runs in Apple-signed
    `com.apple.WebKit.WebContent` XPC processes, not in the host app, so
    `com.apple.security.cs.allow-jit` / `allow-unsigned-executable-memory` are not required.
    The app loads no third-party plug-ins, so `cs.disable-library-validation` is also correctly absent.
    Keeping the file to one key is the right instinct — every extra hardened-runtime exception is a
    Gatekeeper attack-surface grant.
- **Identity resolution** (`:71-85`). The `sed -nE` extraction, the `grep -c . || true` counting under
  `pipefail`, and the refuse-to-guess-on-multiple behaviour were all traced; the counting returns
  `0`/`1`/`2` correctly for empty/one/two inputs (verified).
- **`trap 'rm -rf "$STAGING"' EXIT`** (`:138`) is installed immediately after `mktemp -d` and `$STAGING`
  is quoted throughout. No prior EXIT trap is clobbered. Correct.
- **`hdiutil ... >/dev/null`** (`:143`) redirects stdout only; stderr and the exit status still reach
  `set -e`. No failure is swallowed there.
- **Conventions.** All artifacts are English (§Language Rule). Conventional commits
  (`build(macos):`, `chore(release):`). `caffeinate -i` wraps the build (`:96`) and both notarization
  round trips (`:130`, `:149`) per AGENTS.md §4.

---

## Findings (severity-ordered)

### MINOR-1 — `find` emits parents before children, so the inside-out order breaks for frameworks
- **Location:** `scripts/release-macos.sh:110-117`
- The comment at `:101-102` states the rule correctly ("every nested Mach-O has to be signed before the
  bundle that contains it"), but the `find` at `:114-116` runs in **pre-order**: a directory is printed
  before its contents. Reproduced against a synthetic bundle:

  ```
  /Contents/Frameworks/Foo.framework                        <- signed FIRST
  /Contents/Frameworks/bar.dylib
  /Contents/Frameworks/Foo.framework/Versions/A/libinner.dylib   <- signed AFTER its own framework
  ```

  Signing `Foo.framework` seals its `_CodeSignature/CodeResources`; re-signing `libinner.dylib`
  afterwards invalidates that seal. The enclosing `.app` would then be sealed over a broken framework.
- **Why this is MINOR and not a blocker:** the bundle produced today contains **zero** nested Mach-O —
  `Contents/` holds only `MacOS/polaris-app`, `Resources/icon.icns` and `Info.plist`, so the loop is
  currently a no-op (verified: the `find` returns 0 matches). And `codesign --verify --deep --strict`
  at `:120` would fail loudly rather than ship a broken artifact. It is a latent trap that fires the
  first time a sidecar `.dylib`, a Sparkle/updater framework, or a helper `.app` is added.
- **Fix:** add `-depth` to the `find` (post-order traversal). One word.

### MINOR-2 — the un-stapled notarization `.zip` is left in the shippable output directory
- **Location:** `scripts/release-macos.sh:51`, `:128-129`
- `ZIP_PATH` is `dist/release/Autonomy_<version>_<arch>.zip` and is never removed. Crucially, that zip
  is created at `:129` **before** the staple at `:132`, so the app inside it carries **no** stapled
  ticket. It sits in `dist/release/` next to the `.dmg` that `docs/release-macos.md:60` tells you to
  upload, with a near-identical filename.
- Consequence if someone uploads it (or globs `dist/release/*`): the app is notarized but unstapled, so
  first launch requires an online Gatekeeper round trip and fails on an offline Mac — a softer version
  of exactly the class of bug this PR was written to kill.
- **Fix:** build the zip under `$STAGING` (it is a transient submission artifact, not a release
  artifact), or `rm -f "$ZIP_PATH"` after `stapler staple` succeeds.

### MINOR-3 — the release checklist in the docs omits `README.md`, which carries the version
- **Location:** `docs/release-macos.md:52-53` vs `README.md:5`
- The runbook says "VERSION, `app/src-tauri/tauri.conf.json` and CHANGELOG.md all carry the version.
  Bump them together." But the README download badge embeds the version **twice** in the URL
  (`.../v0.2.2/Autonomy_0.2.2_aarch64.dmg`). This PR bumped it correctly — the documented checklist
  simply does not mention it, so the next release cuts a badge pointing at a 404.
- **Fix:** add `README.md` to the line-52 list.

### MINOR-4 — `notarytool submit --wait` result is never asserted, and the wait is unbounded
- **Location:** `scripts/release-macos.sh:130-131`, `:149-150`
- The script does not check for `status: Accepted`. `--timeout` is also unset, so a stuck Apple-side
  submission blocks the release indefinitely with no ceiling.
- **Partially mitigated:** `set -e` plus the immediately following `xcrun stapler staple` means an
  `Invalid` submission still aborts the script — just with a stapler error instead of the actual
  rejection reason. The troubleshooting table (`docs/release-macos.md:109`) already tells the operator
  to run `notarytool log <submission-id>`, which is the right follow-up.
- **Fix (optional but cheap):** `--timeout 30m`, and capture the submission id so the failure path can
  print `notarytool log <id>` itself instead of making the operator go find it.

### NIT-1 — entitlements are passed to nested binaries, where they are meaningless or wrong
- **Location:** `scripts/release-macos.sh:104-108` (the `sign()` helper is shared by `:112` and `:119`)
- For `.dylib` / `.so`, verified experimentally: `codesign` accepts `--entitlements` and then **silently
  discards** it (`codesign -d --entitlements -` shows no entitlements blob). Harmless no-op.
- For a nested `.app` or a framework bundle it is not a no-op — a helper app would inherit the parent's
  entitlements, which is not how nested code is supposed to be signed (each nested bundle gets its own,
  usually narrower, set).
- Combined with MINOR-1, the cleanest shape is a two-function split: `sign_nested()` with
  `--options runtime --timestamp` and **no** `--entitlements`, and `sign_bundle()` with entitlements.
  No behavioural change today (no nested code exists); worth doing while the loop is still empty.

### NIT-2 — `--help` prints nine lines of shell code
- **Location:** `scripts/release-macos.sh:59`
- `sed -n '2,40p'` overshoots. The comment header ends at line 31; lines 32-40 are
  `set -euo pipefail`, `REPO_ROOT=...`, `cd`, `APP_NAME=`, `BUNDLE_DIR=`, `APP_PATH=`, `ENTITLEMENTS=`.
  Verified by running the same `sed`. Should be `'2,31p'`.

### NIT-3 — the notarytool preflight misreports an offline machine as a bad credential profile
- **Location:** `scripts/release-macos.sh:88-89`
- `xcrun notarytool history` is a network call, and `2>&1` discards the reason. With no connectivity
  (or an Apple outage) the operator is told the profile "is missing or invalid" and will go re-run
  `store-credentials` for nothing.

### NIT-4 — a `find` failure is indistinguishable from "no nested code"
- **Location:** `scripts/release-macos.sh:116`
- `2>/dev/null` inside a process substitution: `pipefail` does not observe the substituted command's
  exit status, so if `find` ever fails the loop simply signs nothing and the script proceeds to seal the
  outer bundle. Today that is invisible because the correct answer is also "nothing".

### NIT-5 — dead guard
- **Location:** `scripts/release-macos.sh:116` — `-not -path "$APP_PATH"` can never match, because the
  `find` root is `$APP_PATH/Contents`. Presumably meant to stop `-name '*.app'` matching the outer
  bundle, which the root already prevents.

### NIT-6 — `hdiutil create` is not wrapped in `caffeinate -i`
- **Location:** `scripts/release-macos.sh:142-143` — UDZO compression of a full app bundle is the one
  remaining multi-minute step not covered per AGENTS.md §4, while the build and both notarization calls
  correctly are.

### NIT-7 — doc hardcodes the architecture the script derives
- **Location:** `docs/release-macos.md:60` says `Autonomy_<VERSION>_aarch64.dmg`, while
  `scripts/release-macos.sh:46-50` derives `ARCH` from `uname -m`. Harmless on Apple Silicon; drifts the
  moment anyone builds under Rosetta or adds an Intel build.

---

## Docs vs. Script Cross-Check

`docs/release-macos.md:74-89` ("What the script does, and why") was checked step by step against the
script. Items 1, 2, 4, 5 and 6 are accurate. Item 3 ("Signs inside-out — nested Mach-O binaries first")
is accurate in intent but not in implementation — see MINOR-1. The flags table (`:66-68`), the
`APPLE_SIGNING_IDENTITY` / `NOTARY_PROFILE` overrides (`:70-72`), the entitlements rationale (`:91-102`)
and the troubleshooting table (`:104-111`) all match the code. The PR description matches the diff and
is honest about the untested path. Only MINOR-3 and NIT-7 are genuine drift.

---

## Version Bump Consistency

Checked repo-wide (excluding `.git`, `node_modules`, `target`, lockfiles):

| Location | Value | Verdict |
|---|---|---|
| `VERSION:1` | `0.2.2` | OK (also fixes the missing trailing newline) |
| `app/src-tauri/tauri.conf.json:4` | `0.2.2` | OK |
| `CHANGELOG.md:39` | `## [0.2.2] - 2026-09-20` | OK, correctly placed below `[Unreleased]` and above `[0.2.1]` |
| `README.md:5` | `v0.2.2` / `Autonomy_0.2.2_aarch64.dmg` | OK (both occurrences) |
| built `Contents/Info.plist` | `CFBundleShortVersionString`/`CFBundleVersion` = `0.2.2` | OK — confirms `tauri.conf.json` is the real source |
| `app/src-tauri/Cargo.toml:3` | `0.1.0` | **Correct, not an oversight** |
| `package.json:3`, `app/package.json:3` | `0.1.0` | Correct, same as prior releases |

`app/src-tauri/Cargo.toml` was last touched in #38, i.e. it already read `0.1.0` when `v0.2.0` and
`v0.2.1` were tagged. Tauri takes the bundle version from `tauri.conf.json`, not the crate manifest, so
`0.1.0` is a private crate version with no user-visible surface. Leaving it is consistent with prior
practice. Nothing was missed. `CHANGELOG.md` has no link-reference section, so no `[0.2.2]: ...` row is
owed. No landing-page or site asset embeds a version (only `README.md` and `docs/release-macos.md`).

Pre-existing and out of scope: the `[Unreleased]` block (`CHANGELOG.md:8-37`) still describes Step A0
work that shipped several releases ago. Not introduced here.

---

## Verdict and Rationale

**APPROVE WITH CHANGES.**

The signing model is right, which is the part that is hard to get right and expensive to get wrong. The
four things that most often break a first Developer ID release — stapling the app before it enters the
DMG, not putting Hardened Runtime or entitlements on the DMG, using the `primary-signature` context for
`spctl` on a DMG, and choosing a staplable image format — are all correct here. The entitlements file is
minimal and complete: one key, correctly chosen, with nothing missing for `SFSpeechRecognizer` or
WKWebView, and no gratuitous hardened-runtime exceptions. The bash is genuinely 3.2-clean.

Nothing found blocks this release. The two items that should land before merge are one-line changes:

1. **MINOR-1** — add `-depth` to the `find` at `scripts/release-macos.sh:114`. It is a no-op today and a
   silent corruption the day a framework or helper app is added. Fix it while it is free.
2. **MINOR-2** — stop leaving the un-stapled `.zip` in `dist/release/` (`:51`, `:128-129`). A wrong
   artifact in the upload directory is the precise failure mode this PR exists to eliminate.

MINOR-3 (add `README.md` to the doc's bump checklist) should land with them; it costs nothing and
prevents a 404 badge next release. MINOR-4 and the NITs are polish and can be deferred.

**The real risk is not in this diff.** The pipeline has never run against a certificate. The merge
decision is sound, but do not treat merge as validation: the first end-to-end run on a machine with a
`Developer ID Application` certificate is the actual acceptance test, and the v0.2.2 DMG must be
downloaded to a **second** Mac and opened before the release is announced. The 0.2.1 artifact passed
every local check too.

## Suggested Next Step

- Apply MINOR-1, MINOR-2, MINOR-3; merge.
- Install the Developer ID certificate, run `make release-macos` end to end, and record the outcome
  (including `spctl` output) in a follow-up backlog note.
- Verify the resulting DMG on a Mac that did not build it, offline, before publishing the release.
