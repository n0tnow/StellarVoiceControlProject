# Touch ID approval gate + approval card + USD approval threshold

- **Date:** 2026-09-20
- **Branch:** `feat/touchid-approval`
- **PR:** https://github.com/n0tnow/StellarVoiceControlProject/pull/29
- **Status:** implemented; **manual Touch ID device test pending** (hardware cannot be driven headlessly). **Review round 1: REQUEST CHANGES addressed — the threshold auto-pay skip turned out to be unexecutable and now fails honestly (§6). The threshold currently only logs eligibility; every payment still shows the card.**

## 1. Scope vs. what already existed

The task brief described the codebase *before* the wallet/UI integration PR (#25,
`d0acfd6`) merged into `main`. After rebasing onto current `origin/main`, most of
the requested feature turned out to **already exist**, so this branch implements
only the genuinely missing piece (the USD threshold) and verifies the rest:

| Requirement | State on `main` before this branch | This branch |
|---|---|---|
| 1. Rust Touch ID command (`LAContext`) | ✅ `app/src-tauri/src/biometric.rs` — `LAContext` via `objc2-local-authentication`, `DeviceOwnerAuthentication` policy (Touch ID first, **device-password fallback** — a password is still a present-human proof; refusing it would lock out Macs without Touch ID), `mpsc` bridge to the blocking pool, 60 s `AUTH_TIMEOUT`, reason sanitizing (control/bidi chars stripped, 120-char cap), `policy_support()` health probe. Tauri commands `approval_begin` / `approval_authorize` / `approval_deny` / `approval_status` / `approval_current` registered in `lib.rs`. | Verified only; no Rust changes. Cargo 317 tests green. |
| 2. Approval card UI | ✅ `app/src/panels/ApprovalPanel.tsx` + `app/src/panels/approval/` (`ApprovalCard`, `approvalFlow` state machine, `SummaryLines`, `HashFingerprint`, demo fixtures) as a dedicated always-on-top panel window; driven by the typed event stream (`approval_request` / `approval_result`) **plus** hydration from `approval_current` so a missed event is recovered. The approver (`app/src/lib/approver.ts`) is fail-closed: `approved: true` only when the gate itself reports `authorized` (event **and** poll; a forged event alone never approves). Deny/cancel/timeout settle the turn with a label + spoken failure via the existing turn-session/speech path. | Verified only. See the notch-surface deviation note below. |
| 3. User-configurable USD threshold | ❌ nothing existed (`approvalThresholdUsd` absent; the Settings panel was read-only). | **Implemented here** — §2. |
| 4. Sign/submit after approval | ✅ `app/src/lib/signing.ts` (`signAndSubmit`) + the W4 bridge: authorized XDR → Freighter via the localhost bridge server → `submitSignedTx` → `tx_submitted` event with explorer URL. | Verified only; no invented submit path. |

**Notch-surface deviation:** the card is a separate always-on-top panel window
(`panels::APPROVAL`), not a notch shell state — during the wait the notch shows
"Approve in Polaris" (`awaiting_approval` stage, F1) while the interactive card
floats above other windows. A true notch-shell approval card is follow-up (§5).

## 2. What this branch adds — `approvalThresholdUsd`

The owner's local, app-side auto-approval ceiling (USD). Default `0` = *always
ask* (decision D10).

**Files:**

| File | What |
|---|---|
| `app/src/lib/preferences.ts` | Minimal persisted preference store on `localStorage` (key `polaris.preferences`, one JSON blob). Fail-closed load (missing/corrupt/unavailable storage → defaults), clamped save (NaN/negative/∞/`> 1 000 000` sanitized). `PreferenceStore` seam injected in tests. |
| `app/src/lib/approvalPolicy.ts` | Pure `decideApproval({kind, asset, amount, summaryLines, thresholdUsd})` → `card` / `auto` with a reason. Holds the precedence rules. |
| `app/src/lib/thresholdApprover.ts` | `IntentApprover` wrapper. **After review round 1:** on `auto` it only *logs* the eligibility via `webLog` and still defers to the wrapped Touch ID approver — the earlier "approve without the gate" behaviour could never be signed (`bridge_sign` needs a gate-registered id) and silently swallowed the payment (§6, CRITICAL-1). On `card` it defers untouched. |
| `app/src/lib/chain.ts` | The Tauri runtime approver is now `thresholdApprover(Touch ID approver)`; the composition-root comment documents the precedence and the interim behaviour. Non-Tauri paths (deny-all / opt-in auto placeholder) unchanged. |
| `app/src/panels/SettingsPanel.tsx` | One editable section, "Approval threshold": number input + Save, `aria-live` hint, current-value echo. The panel stays read-only otherwise; this is the single writable preference. Copy updated in round 1 to say the threshold takes effect once automatic payments land (every payment still asks today). |
| Tests | `preferences.test.ts` (6), `approvalPolicy.test.ts` (13), `thresholdApprover.test.ts` (8), `signing.test.ts` (18) — covering below/above/**exactly-at** threshold, non-USD asset, chain-required card, corrupt store, empty/NaN/negative/**hex/exponent/whitespace** amount, override, deny pass-through, the gateless-approval fail-closed guard, and the thresholdApprover → `executeIntent` → `signAndSubmit` integration. |

### Precedence (also in code comments)

1. **The chain always wins.** A summary line `Approval card required: yes`
   forces the card regardless of the threshold — the app can only be stricter
   than the chain, never looser (D10c). **Corrected in review round 1
   (MAJOR-2):** that line is *not* proof the chain vetted the payment. It is
   emitted for the `pay_owner` route (`stellar/src/approval/routing.ts`), and
   `pay_owner` **skips** the agent-facing guardrails (`auto_approve_limit`,
   `known_recipients_only`, `allowed_assets`) by design
   (`contracts/polaris_guard/src/lib.rs`). Today the app never sets an
   `approvalProfile`, so `DEFAULT_APPROVAL_PROFILE` = `always_ask` forces
   `pay_owner` for every payment and the line appears on all of them; the
   on-chain auto-approve limit binds only the `pay_executor` route, which is
   not wired (§6).
2. **Non-USD assets always ask.** `XLM` has no price oracle here; its USD value
   is unknown, and unknown means *ask*. Documented limitation — no oracle added.
3. **USD stablecoins 1:1.** `USDC`, `PGUSD` — exactly the codes the chain asset
   registry in `stellar/src/payments/assets.ts` pins (the earlier list also had
   a bare `USD`, which the registry does not pin; removed in round 1, MAJOR-3).
   Assumption stated in code: 1:1 USD peg, 7 decimals. Only `send` intents are
   eligible.
4. **Strictly below.** A payment *at* the threshold still shows the card.
   Deliberate divergence from the D10b wording ("at or below"): the app side may
   only be *stricter*, and an exact hit is not "small change".
5. **Interim: eligibility, not execution.** Even an auto-eligible payment shows
   the card today (round 1, CRITICAL-1): there is no approvalId-less signing
   leg. See §6.

## 3. Decisions

- **No new Rust `authenticate_touch_id` command.** The brief asked for one, but
  the merged gate already exposes `approval_authorize(id)`, which shows the
  Touch ID prompt *and* binds the gesture to one specific hash-verified XDR in
  the fail-closed store. A freestanding `authenticate_touch_id(reason) -> bool`
  would be an **unbound** yes/no oracle — strictly weaker, and a second path to
  audit. The existing command is the safer design; the brief's requirements
  (canEvaluatePolicy + fallback, localized reason, Ok/Err mapping, async bridge)
  are all met in `biometric.rs`/`approval.rs`.
- **No threshold change to the Rust gate.** The threshold is a webview-side
  preference in front of the gate; the gate itself stays fail-closed and
  unchanged. A stored preference can never weaken the Rust boundary — worst
  case it reverts to `0` (always ask). **Amended in round 1:** the preference
  no longer weakens the *gate* at all — since the auto-skip was unexecutable
  (CRITICAL-1), the wrapper now only logs eligibility and always defers.
- **localStorage, not a new Rust config command.** The smallest persistence
  matching existing patterns (the `.env`-backed settings are process-wide
  config; this is a per-user UI preference, like the panel demo flags).

## 4. Validation

| Check | Result |
|---|---|
| `npm run check` (app, `tsc`) | ✅ green |
| `npm test` (app, `node --test`) | ✅ **376/376** (+23 new) |
| `npm test` (agent) | ✅ 182/182 |
| `cargo test` (`app/src-tauri`) | ✅ 317 passed, 0 failed |
| `npm run build` (app, vite) | ✅ green (two pre-existing `INEFFECTIVE_DYNAMIC_IMPORT` warnings, unrelated) |

**Tested: build + unit tests; manual Touch ID device test pending.** Touch ID
hardware cannot be driven headlessly; the biometric self-test
(`biometric_selftest`, Debug panel) plus a real "send 5 USDC" turn on a Mac with
Touch ID remain to be run by a human (the sprints.md W3 accept row already
tracks exactly this).

## 5. Remaining work / follow-ups

1. **Manual device test** — real Touch ID prompt, password fallback, cancel;
   then tick the sprints.md W3 accept row.
2. **Notch-shell approval card** (original brief's variant) — render the
   approval card *inside* the notch as a new shell state instead of the
   separate always-on-top panel. The panel works today; the notch variant is a
   UX follow-up needing a new `SHELL_STATES` row + interactive-card plumbing in
   `notch.rs`/`ShellSurface`.
3. **Price oracle for XLM** (optional) — if non-USD assets should ever be
   threshold-eligible, a priced conversion must be added; until then they
   always ask (documented in `approvalPolicy.ts`).
4. **Voice path to set the threshold** — D10b allows "don't ask me for payments
   under 25 USDC" by voice; today the threshold is Settings-panel-only. A voice
   set must follow the D10c read-back + one-card + Touch ID rule (loosening is
   never silent).

## 6. Review round 1 (2026-09-20, independent reviewer → REQUEST CHANGES)

### CRITICAL-1 — Auto-approve path could never execute (FIXED by making it honest)

The wrapper returned `{ approved: true }` with **no** `approvalId`, but
`signAndSubmit` → Rust `bridge_sign` only releases an XDR for a gate-registered
`Authorized` approval id. A threshold-skipped payment therefore settled as
`executed` with no `txHash`, no `tx_submitted` event and no stage callbacks —
the turn quietly ended without moving anything.

**Chosen resolution: honest deferral, not speculative plumbing.** The intended
auto path (per D10b) is the executor route: a chain-built `pay_executor` XDR
signed by the registered executor key, with `polaris_guard.pay_executor`
enforcing `auto_approve_limit` / `known_recipients_only` / `allowed_assets`
on-chain. That leg does **not** exist in the app today:

- the shell holds no executor secret (the whole point of the gate is that the
  webview never signs unattended);
- the payment tool never receives an `approvalProfile`, so
  `DEFAULT_APPROVAL_PROFILE` = `always_ask` resolves every payment to
  `pay_owner` (`stellar/src/payments/sendPayment.ts`) — the guarded
  `pay_executor` builder is never selected;
- `signEnvelope` (`stellar/src/live/signer.ts`) is testnet-only live tooling,
  not an app signer.

Building that leg here would mean storing/managing an executor key in the app —
a security-design decision, not a review fix. Instead:

- `thresholdApprover`: an `auto` decision is logged (`webLog`) and the request
  is handed to the Touch ID gate like any other — **every payment still shows
  the card**; the threshold is currently a no-op beyond the log.
- `signAndSubmit`: fail-closed guard — an `executed` outcome without an
  `approvalId` becomes a clearly-labelled non-executed failure ("Approval
  required — automatic payments are not available yet; approve it via the
  approval card, or lower the amount") instead of a transaction-free success,
  so any future gateless approver cannot silently regress this.
- Integration test pins the honest path end-to-end:
  `thresholdApprover → executeIntent → signAndSubmit` yields a real submitted
  transaction (`txHash`, `tx_submitted`, signing/submitting stage callbacks),
  and the no-approvalId outcome is pinned as a labelled failure.

**New backlog item (blocks the actual threshold auto-pay):** wire the
executor-signing leg — owner-driven `set_rule` + `set_executor` onboarding
(D10c read-back + card), executor key custody in Rust (not the webview),
`approvalProfile: auto_under_limit` plumbing into the payment tool, and an
approvalId-less `pay_executor` sign+submit leg with its own stage callbacks and
`tx_submitted`. Until then the Settings-panel copy says the threshold takes
effect "once automatic payments land".

### MAJOR-2 — Inverted security rationale (FIXED, docs/comments)

The claim "the skip can never approve something the chain forbade" was wrong:
`Approval card required: yes` is only emitted for `pay_owner`, and `pay_owner`
**skips** the on-chain `auto_approve_limit` / `known_recipients_only` /
`allowed_assets` by design. Corrected in `thresholdApprover.ts`,
`approvalPolicy.ts`, `preferences.ts`, `chain.ts` comments,
`docs/approval-and-scheduling.md` §2 and this report: today every payment is
forced to `pay_owner` + the Touch ID card; the threshold only becomes
meaningful with the executor route; the on-chain auto-approve limit applies to
the executor route, not the owner route.

### MAJOR-3 — USD asset list duplication (FIXED)

`USD_STABLE_ASSETS` reduced from `["USDC", "PGUSD", "USD"]` to `["USDC",
"PGUSD"]` — exactly what the chain registry (`stellar/src/payments/assets.ts`)
pins. The 1:1-peg and 7-decimals assumptions are now stated in the comment; a
bare "USD" code is not registry-pinned and would be refused by the chain tool
long before the policy is consulted. (A fully derived single source is not
practical: the app package has no static import of the stellar registry today
— `@polaris/stellar` is lazy-loaded — so the list mirrors the registry with a
comment instead.)

### MINOR-4 — Lax amount parsing (FIXED)

`decideApproval` now validates with a strict decimal regex mirroring the chain
layer (`stellar/src/guard/amount.ts` `AMOUNT_RE`: 1–12 integer digits, ≤7
fraction digits, no sign/exponent/whitespace) before calling `Number()`.
`"0x10"`, `"1e2"`, `" 5 "`, `".5"`, `"5."`, `"+5"`, `"1_0"` and over-digit-cap
values are all unreadable → card. Tests added.

### MINOR-5 — Precedence pin (FIXED)

Pure-function test added: `kind:"send"`, `asset:"USDC"`, `amount:"10"`,
`thresholdUsd:25` **plus** `"Approval card required: yes"` → `card` (chain wins
over a would-be auto combination).

### NIT-6 — Dead `threshold` UI state (kept, with justification)

`SettingsPanel.tsx`'s `threshold` state is **not** redundant: it renders the
saved-value echo (`Current: always ask / $25`) and is refreshed after a
sanitised save, while `thresholdDraft` is the (possibly invalid) input text.
Removing it would leave the echo permanently stale or force a re-read on every
render. Left in place.

### NIT-7 — Docs updated to the actual working state

`docs/approval-and-scheduling.md` §2 and this report now state the interim
behaviour (every payment asks; threshold = logged eligibility) and the
executor-signing dependency; Settings copy matches.

### Post-fix validation (all `caffeinate -i`)

| Check | Result |
|---|---|
| `npm run check` (app, `tsc`) | ✅ green |
| `npm test` (app) | ✅ **388/388** (+12 vs round 0) |
| `npm test` (agent) | ✅ 190/190 |
| `npm test` (stellar) | ✅ 67/67 |
| `npm run build` (app, vite) | ✅ green (pre-existing `INEFFECTIVE_DYNAMIC_IMPORT` warnings only) |
| `cargo test` (`app/src-tauri`) | ✅ 319 passed, 5 ignored, 0 failed |

### Remaining known limitations

1. **Threshold auto-pay is inert by design** until the executor-signing leg
   (new backlog item above) lands; the setting only logs eligibility.
2. The fail-closed guard in `signAndSubmit` means the
   `POLARIS_ALLOW_AUTO_APPROVE=1` CLI/demo placeholder now ends at the
   "Approval required" label instead of a silent `executed` — that placeholder
   never moved real value (Tauri-only gate), so no demo path is lost.
3. Manual Touch ID device test, notch-shell card variant, XLM price oracle and
   the voice-set threshold flow remain as listed in §5.
