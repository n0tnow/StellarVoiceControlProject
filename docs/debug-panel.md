# Polaris Debug panel and FeatureChecks

> Step W0b. The Debug panel is the one place that answers, for every feature we
> add, "is it working **right now**?" — or why not. This document is the contract
> for plugging a feature in. A later milestone adds **one file** and touches
> nothing else.

The checks are rendered inside the notch Settings page's Diagnostics section
(`app/src/notch/settings/DiagnosticsSection.tsx`), which runs the registry on
demand ("Run all checks"). This doc owns the check contract; the notch surface
itself is covered by `docs/notch-ui.md`.

## 1. The contract

A **FeatureCheck** (TypeScript) default-exports:

```ts
{
  id: string;                 // stable, unique, e.g. "voice"
  title: string;              // human label, e.g. "Voice pipeline config"
  milestone: `W${number}`;    // e.g. "W0", "W3"
  run(): Promise<CheckResult>;// non-destructive, never prompts, never moves funds
  actions?: CheckAction[];    // explicit self-tests with side effects (see §4)
}
```

A **CheckResult** is:

```ts
{
  status: "ok" | "warn" | "fail" | "unknown";
  detail: string;   // one line a non-developer can act on; never a secret
  checkedAt: number; // ms since the epoch
}
```

A **FeatureHealth** (Rust feature, from the project Debug contract) has the same
shape with camel-cased fields. Rust features expose a `pub fn health(...)` in
their module plus a `<feature>_health` Tauri command; the TS check maps the
command's facts to a `CheckResult`. `voice_health` (in
`app/src-tauri/src/voice_health.rs`) is the one that exists today.

## 2. Adding a check (the whole procedure)

1. Create `app/src/debug/checks/<feature>.ts`, default-exporting a `FeatureCheck`.
2. That is it. `registry.ts` globs `./checks/*.ts` at build time, sorts by
   milestone then id, and the panel runs every check on open.

A module that does not default-export a check (a typo, a stray helper) is shown
as a `fail` entry naming the file — it never takes the panel down. Keep helper
modules **outside** `checks/` for that reason.

### A 15-line example

```ts
// app/src/debug/checks/stellar_config.ts
import { getStellarConfigIfAvailable } from "@/debug/commands";
import { makeResult } from "@/debug/runner.ts";
import type { FeatureCheck } from "@/debug/types.ts";

export default {
  id: "stellar-config",
  title: "Owner account config",
  milestone: "W1",
  async run() {
    const config = await getStellarConfigIfAvailable();
    return config
      ? makeResult("ok", `owner ${config.ownerAddress ?? "unknown"}`)
      : makeResult("warn", "stellar_config is not present on this build");
  },
} satisfies FeatureCheck;
```

## 3. Choosing a status

`ok` = verified live just now; `warn` = configured/degraded but not fully
verified; `fail` = broken (the detail says why in one actionable sentence);
`unknown` = not run yet.

Rules of thumb, from the checks that ship today:

- **Only claim what you checked.** `app.ts` calling `app_info` and getting an
  answer is a live `ok`. A check that only reads configuration is `warn` when it
  cannot be sure the feature works (e.g. on-device STT availability,
  `voice.ts`).
- **Degraded but working is `warn`, not `fail`.** Missing `FISH_AUDIO_API_KEY`
  is a `warn` because the local macOS fallback still speaks; a missing
  `GROQ_API_KEY` is a `fail` because transcription stops.
- **Not-yet-observed is `unknown`.** `hotkey.ts` reports `unknown` with "hold
  Control+Option once, then run again" until it has seen a
  `hotkey_permission` event.
- **Wrap the call.** A Tauri command that rejects should become a `fail` with
  `errorDetail(error)`, not an unhandled rejection.
- **Use `makeResult`.** It scrubs the detail and stamps `checkedAt` on every
  path at once.

## 4. Actions (side-effecting self-tests)

An action is an explicit, user-triggered self-test with a side effect the user
notices — showing the Touch ID prompt, speaking a test phrase. They are
**never** run by `runAll` or when the panel opens; the panel only renders them
as clearly-labelled secondary buttons.

```ts
actions: [
  {
    id: "touch-id",
    label: "Test Touch ID",
    description: "Shows the Touch ID prompt (a visible side effect).",
    run: () => invokeTest(),
  },
]
```

No shipped check has an action yet. The contract is locked by a fixture-only test
in `app/src/debug/runner.test.ts`.

## 5. What never goes into `detail`

- **No secrets:** no API key, no key prefix, no Stellar seed, no auth token.
  Public addresses are fine.
- No environment values read from `.env`; report **presence** as a boolean, as
  `voice_health` does.
- No multi-line dumps. `detail` is one line a non-developer can act on.

`redact.ts` is the last line of defence: every result is passed through it (in
`runner.ts`) and every event-tail line is scrubbed before it renders or is
copied. It redacts `sk-…`, `gsk_…`, 56-char Stellar **seeds** (`S…`) and long
base64/hex blobs, and deliberately **preserves** 56-char Stellar public keys
(`G…`) because they are not secrets.

## 6. The panel itself

- **Checks list:** status badge (colour **and** text), title, milestone tag,
  one-line detail, "last checked" time, and a **Run** button per check.
- **Run all** runs every check with bounded concurrency (4) and a 5 s timeout
  per check; one failure never stops the others.
- **Auto-run:** the non-destructive checks run once when the panel opens.
  Actions never do.
- **Event tail:** the last 50 `polaris-event`s, type plus a short payload,
  scrubbed with `redact` (transcripts may appear — this is a local debug view).
- **Copy report:** copies `{ app, ownerAddress, checks, last 20 events }` as JSON,
  redacted, to the clipboard.
- The header feature-detects `stellar_config`; on branches without it the owner
  address is simply absent.

## 7. Files

| File | Role |
|---|---|
| `app/src/debug/types.ts` | the contract types (type-only; Node-safe) |
| `app/src/debug/registry.ts` | collects `checks/*.ts`; ordering; malformed tolerance |
| `app/src/debug/runner.ts` | timeout, error→`fail`, bounded concurrency, redaction |
| `app/src/debug/redact.ts` | defensive secret scrubbing |
| `app/src/debug/eventTail.ts` | the last-50-event ring the panel and hotkey check read |
| `app/src/debug/commands.ts` | debug-only typed command wrappers |
| `app/src/debug/checks/*.ts` | one file per feature |
| `app/src-tauri/src/voice_health.rs` | the Rust `voice_health` facts |

## 8. Verifying

```bash
npm run check -w @polaris/app
npm test -w @polaris/app
npm run build -w @polaris/app
cargo test --manifest-path app/src-tauri/Cargo.toml
cargo clippy --manifest-path app/src-tauri/Cargo.toml -- -D warnings
```

**Automated:** the runner's timeout/isolation/concurrency, the registry's
ordering and malformed-module tolerance, `redact` on every secret shape (and the
public-key non-false-positive), the hotkey check, the `#/debug` route, and the
`voice_health` mapping (including "no serialized output contains a key value").

**Human on a real Mac (not verified by CI):** the tray **Debug…** item opens the
panel; badges render with colour **and** text; **Copy report** puts redacted JSON
on the clipboard; the event tail fills as you use the push-to-talk gesture.
