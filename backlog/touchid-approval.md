# Touch ID approval gate + approval card + USD approval threshold

- **Date:** 2026-09-20
- **Branch:** `feat/touchid-approval`
- **PR:** _opened with this report; link added by the coordinator_
- **Status:** implemented; **manual Touch ID device test pending** (hardware cannot be driven headlessly)

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
| `app/src/lib/thresholdApprover.ts` | `IntentApprover` wrapper: on `auto` it returns `{ approved: true }` **without registering with the Rust gate** (no `approval_request` event, no card that could linger) and logs the skip via `webLog`; on `card` it defers to the wrapped Touch ID approver untouched. |
| `app/src/lib/chain.ts` | The Tauri runtime approver is now `thresholdApprover(Touch ID approver)`; the composition-root comment documents the precedence. Non-Tauri paths (deny-all / opt-in auto placeholder) unchanged. |
| `app/src/panels/SettingsPanel.tsx` | One editable section, "Approval threshold": number input + Save, `aria-live` hint, current-value echo. The panel stays read-only otherwise; this is the single writable preference. |
| Tests | `preferences.test.ts` (6), `approvalPolicy.test.ts` (10), `thresholdApprover.test.ts` (7) — covering below/above/**exactly-at** threshold, non-USD asset, chain-required card, corrupt store, empty/NaN/negative amount, override, deny pass-through. |

### Precedence (also in code comments)

1. **The chain always wins.** A summary line `Approval card required: yes`
   (guard/contract requirement) forces the card regardless of the threshold —
   the app can only be stricter than the chain, never looser (D10c).
2. **Non-USD assets always ask.** `XLM` has no price oracle here; its USD value
   is unknown, and unknown means *ask*. Documented limitation — no oracle added.
3. **USD stablecoins 1:1.** `USDC`, `PGUSD`, `USD` (the codes the chain asset
   registry in `stellar/src/payments/assets.ts` allows) are treated as
   USD-pegged. Only `send` intents are eligible for the skip.
4. **Strictly below.** A payment *at* the threshold still shows the card.
   Deliberate divergence from the D10b wording ("at or below"): the app side may
   only be *stricter*, and an exact hit is not "small change".

## 3. Decisions

- **No new Rust `authenticate_touch_id` command.** The brief asked for one, but
  the merged gate already exposes `approval_authorize(id)`, which shows the
  Touch ID prompt *and* binds the gesture to one specific hash-verified XDR in
  the fail-closed store. A freestanding `authenticate_touch_id(reason) -> bool`
  would be an **unbound** yes/no oracle — strictly weaker, and a second path to
  audit. The existing command is the safer design; the brief's requirements
  (canEvaluatePolicy + fallback, localized reason, Ok/Err mapping, async bridge)
  are all met in `biometric.rs`/`approval.rs`.
- **No threshold change to the Rust gate.** The skip is a webview-side
  convenience in front of the gate; the gate itself stays fail-closed and
  unchanged. A stored preference can never weaken the Rust boundary — worst
  case it reverts to `0` (always ask).
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
