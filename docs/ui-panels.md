# Polaris UI panels

> Step W0. How the interactive panel windows work, how to add one, what the rules
> are, and how to run and verify them. Written for the frontend owner, who adds
> panels **without touching Rust**.

## 1. Why panels exist

The only window so far is the notch overlay (`app/src-tauri/src/notch.rs`): it is
transparent, click-through (`set_ignore_cursor_events(true)`), non-focusable and
always on top. That is exactly right for a HUD and exactly wrong for anything the
user must click: approval cards, wallet info, settings.

Panels are ordinary, on-demand, focusable windows. They reuse the overlay's
`index.html` — one bundle serves every window — and are selected by the **URL
hash**: Rust opens `index.html#/wallet`, and `app/src/main.tsx` reads the hash to
choose the component.

| Window | Label | Route | Size | Behaviour |
|---|---|---|---|---|
| (overlay) | `main` | no hash / `#/` | 780×120 (fixed) | transparent, click-through, non-focusable |
| Wallet | `panel-wallet` | `#/wallet` | 420×600 | normal window, resizable |
| Approval | `panel-approval` | `#/approval` | 440×520 | always on top, not resizable |
| Security | `panel-security` | `#/security` | 460×640 | normal window, resizable |
| Schedules | `panel-schedules` | `#/schedules` | 460×640 | normal window, resizable |
| Suggestions | `panel-suggestions` | `#/suggestions` | 460×640 | normal window, resizable |
| Anchor | `panel-anchor` | `#/anchor` | 460×640 | normal window, resizable |
| P2P | `panel-p2p` | `#/p2p` | 460×640 | normal window, resizable |
| Settings | `panel-settings` | `#/settings` | 520×600 | normal window, resizable |
| Debug | `panel-debug` | `#/debug` | 480×680 | normal window, resizable |

Security, Schedules, Suggestions, Anchor and P2P are skeletons registered now so
parallel UI workers can each fill one body without registry conflicts.

One instance per label: the first open builds the window, later opens show and
focus it. Closing a panel **hides** it (`panels::handle_window_event`) so its
webview — and any state in it — survives until the next open, and closing never
quits the app.

## 2. The Rust registry (`app/src-tauri/src/panels.rs`)

`PANELS` is a fixed allow-list of `PanelSpec`s (name, label, title, route,
width, height, always-on-top, resizable). Everything else derives from it:

- `open_panel(name)` — the Tauri command the webview calls. Unknown names come
  back as `PanelError::UnknownPanel { name }` (`{"kind":"unknownPanel",…}`);
  window failures as `PanelError::Window { message }`. It never panics.
- `panels::open(app, name)` — the Rust helper the `open_panel` command calls.
- `is_panel_label(label)` — recognises the `panel-*` namespace, which is also
  what the capability file targets and what the close handler checks.

Adding a panel on the Rust side is a new `PanelSpec` entry — nothing else. The
frontend must add the matching name to `panelRoutes.ts` in the same PR.

## 3. Opening panels and quitting

Polaris is an **accessory** app (no Dock icon, no app menu bar) and has **no
menu-bar tray**. The notch is the only surface: the expanded panel's **"⋯" menu**
(`app/src/notch/MoreMenu.tsx`, entries in `lib/panels.ts::MORE_MENU`) opens every
ordinary panel and quits.

- **Security & rules / Schedules / Suggestions / Anchor / P2P / Privacy /
  Settings / Debug** → `openPanel(name)` (`open_panel`)
- **Quit Polaris** → `quitPolaris()` → the `quit_app` command (`app.exit(0)`)

The trigger is a small button in the panel footer; Escape and a click outside
close the menu, and both the trigger and its items are real buttons (keyboard
reachable). The approval panel is intentionally **not** in the menu: it is opened
by the approval flow, never by hand. Wallet is a notch page, so it is not
repeated in the menu.

## 4. Adding a panel

1. **Rust** (`app/src-tauri/src/panels.rs`): add a `PanelSpec` to `PANELS`.
   Keep the label `panel-<name>` (the capability glob and the close handler
   depend on it) and set `route: "#/<name>"`. Update the allow-list test.
2. **Route** (`app/src/panels/panelRoutes.ts`): add the name to `PanelName` and
   `PANEL_NAMES` — this is the frontend's **single source of truth**
   (`@/lib/panels` re-exports the union, it must not redeclare it).
   `parsePanelRoute` then recognises `#/<name>`; unknown hashes still fall back
   to the notch.
3. **Component** (`app/src/panels/<Name>Panel.tsx`): wrap the content in
   `PanelShell` (shared chrome) and use `Button` from
   `@/components/ui/button`. Wire it in `PanelRoot.tsx`.
4. Add tests for any new pure logic in `panelRoutes.test.ts`.

The Rust window is created before the webview loads, so the component only has
to render — there is no "panel not found" state.

## 5. Calling the shell from a panel

Two wrappers, both in `app/src/lib/`:

- **Events:** subscribe with the `usePolarisEvents` hook
  (`app/src/panels/events.ts`), which wraps `listenPolarisEvents` from
  `@/lib/polaris`. That helper owns the listener and the runtime guard
  (`isPolarisEvent`); the hook only owns mount/unmount. Pass a `useCallback`'d
  handler or the subscription is rebuilt every render.

  The typed union is `PolarisEvent` in `@polaris/interfaces` (mirrored by
  `app/src-tauri/src/events.rs`): `capture_status`, `transcript`,
  `agent_status`, `speech_status`, `approval_request`, `approval_result`,
  `tx_submitted`, `error`, …

- **Commands:** `openPanel(name)` from `@/lib/panels` opens another panel
  (`open_panel`). No other panel command exists yet; add new shared commands to
  `app/src/lib/` (never call `invoke` ad hoc from a component) so the Rust
  contract stays in one place. Debug-only commands are the one exception and are
  centralised in `app/src/debug/commands.ts` (`docs/debug-panel.md`).

## 6. Rules — do / don't

**Do**

- Keep panels presentation-only until their milestone lands. The skeletons are
  labelled with the milestone that fills them in.
- Take all shell access through `@/lib/polaris`, `@/lib/panels` and
  `@/panels/events`.
- Keep the hash grammar in `panelRoutes.ts` and the routes in Rust in step; both
  sides are tested.

**Don't**

- **Never call the chain from a panel.** Value-moving work goes through the
  single execution seam (`@/lib/chain.ts`) driven by the approval flow, not by a
  button in a window.
- **Never handle secrets.** No key, seed or API credential may reach a panel or
  any other webview. Signing is a Rust command behind Touch ID.
- **Never bypass the approval events.** The only approved path is
  `approval_request` → (user gesture) → `approval_result` → `tx_submitted`; a
  panel listens to those events, it does not invent its own.
- **Deny by default.** A new action must be fail-closed until a real gesture
  authorises it; never enable `POLARIS_ALLOW_AUTO_APPROVE`.

## 7. Running and verifying

```bash
make dev            # Tauri dev (Vite HMR)
npm run check -w @polaris/app
npm test -w @polaris/app
cargo test --manifest-path app/src-tauri/Cargo.toml
cargo clippy --manifest-path app/src-tauri/Cargo.toml -- -D warnings
```

### Checklist

**Automated (covered by tests)**

- `parsePanelRoute` maps every registered route and falls back to the notch for
  unknown/malformed hashes (`app/src/panels/panelRoutes.test.ts`).
- The Rust registry is the known panels, rejects unknown names with
  `PanelError::UnknownPanel`, and every spec has sane geometry, a `#/name`
  route and a `panel-*` label (`app/src-tauri/src/panels.rs`).
- `npm run check`, `npm test -w @polaris/app`, `npm run build -w @polaris/app`,
  `cargo test` and `cargo clippy -D warnings` are all green.

**Human on a real Mac (not verified by CI)**

- There is **no** menu-bar tray icon and the app keeps **no** Dock icon
  (accessory policy unchanged).
- The panel's **"⋯" menu** opens a focusable window for each entry; it can be
  typed in and clicked.
- **Quit Polaris** in the menu exits the app.
- Pressing **Close** hides the panel and the app stays alive; opening the panel
  again from the menu brings the **same** instance back.
- **Settings…** opens the Settings panel and the metadata it reads
  (`app_info`) is correct.
- The unknown-name path: calling `open_panel` with a bad name returns the
  `unknownPanel` error rather than opening a window.

## 8. Approval card (`#/approval`)

> Step W2. The card is the webview face of the Rust Touch ID gate (W3). It never
> signs: it renders the decoded summary, collects the gesture, and reflects what
> the store reports.

**Files.** Logic is split from presentation so the frontend owner can restyle it:
`app/src/panels/approval/approvalFlow.ts` is a pure reducer (no React, no Tauri);
`ApprovalCard.tsx` / `SummaryLines.tsx` / `HashFingerprint.tsx` are the view;
`app/src/lib/approval.ts` is the typed command seam; `demo.ts` is the fixture
command set.

**States.** `idle → pending → authorizing → authorized | denied | expired`,
plus a terminal `error`. Only `pending` (before `expiresAtMs`) enables Approve;
`authorizing` locks it against a double click. Focus starts on **Deny**, Esc
denies, and any unrecognised snapshot state fails closed into `error`.

**Hydration.** The window can open after `approval_request` was emitted, so the
panel calls `approval_current()` on mount and re-reads it on every
`approval_request` / `approval_result` event. A result event for a different
`payloadHash` is ignored.

**Commands** (Tauri, camelCase args). None returns the XDR:

- `approval_current() -> ApprovalSnapshot | null`
- `approval_authorize(id) -> ApprovalSnapshot`
- `approval_deny(id) -> ApprovalSnapshot`

An `ApprovalSnapshot` is `{ id, payloadHash, summary, intent, mode, state,
expiresAtMs }`, where `mode` is `touch_id | wallet_only` and `state` is
`pending | authorized | denied | expired | consumed`. A rejected command rejects
with `{ kind, message }`, `kind` ∈ `cancelled | failed | unavailable | timeout |
expired | notPending`; a `cancelled` gesture returns the card to `pending` with a
calm hint.

**Demo URLs.** `#/approval?demo=1` (live, Approve simulates a 1 s Touch ID),
`#/approval?demo=expired`, `#/approval?demo=error`. Demo mode swaps in fixture
commands and shows a mandatory “DEMO — nothing is signed” banner; real mode
(`#/approval` with no `demo`) never uses a fixture.

## 9. Signing flow (`#/approval` → Freighter → submit)

> Step W4b. How an approved card becomes a signed, submitted transaction, and
> where the gate sits. Rust owns the gate and the bridge; the webview only
> orchestrates and announces the result.

The value-moving path is one chain of typed seams, each of which fails closed:

1. **Build.** `executeIntent` (`@polaris/agent`) runs the chain tool, which
   returns an unsigned XDR + decoded summary, then asks the approver. The
   approved request now also carries `unsignedXdr` so the gate can bind it to
   `payloadHash`.
2. **Approve.** `app/src/lib/approver.ts` (`createTouchIdApprover`) registers
   the request with `approval_begin`, opens `#/approval`, and waits (≤ 130 s) on
   the `approval_result` event **and** `approval_status` polling. It resolves
   `{ approved: true }` only when the gate reports the exact `payloadHash` as
   `authorized`; denied, expired, timed-out, superseded and errored are all
   `false`. `chain.ts` selects it when a Tauri runtime is present;
   `POLARIS_ALLOW_AUTO_APPROVE` stays opt-in and only applies outside Tauri.
3. **Sign.** `app/src/lib/signing.ts` calls `bridge_sign(id)`. Rust takes the
   XDR from the gate via `take_authorized(id)` — the only path by which XDR
   leaves the gate — mints a one-time loopback token, opens the user's browser at
   the bridge page, and waits for the wallet. Rust independently verifies the
   returned envelope before reporting `ok`.
4. **Submit.** `submitSignedTx(signedXdr, unsignedXdr)` submits over Horizon. The
   returned hash must equal the `txHash` Rust computed; a mismatch is a labelled
   failure, never a silent success.
5. **Emit.** The webview cannot emit a typed `polaris-event`, so it calls the one
   narrow Rust command `tx_submitted_emit(hash, explorerUrl)`, which validates
   the pair (64 lowercase hex; the canonical testnet link for that hash) and then
   emits `tx_submitted`. The shell speaks the localized “Sent 10 XLM to acc2”
   line and links the transaction on stellar.expert.

Every failure maps to a short human label on the `ExecutionOutcome` (e.g.
“Cancelled”, “Wallet didn't sign”, “Transaction expired”), is spoken briefly,
and settles the turn — nothing throws and the notch never sticks.

**Debug checks** (`docs/debug-panel.md`): `network.ts` (config, testnet, owner,
alias, Horizon balance), `approval.ts` (`biometric_health` + a “Test Touch ID”
action), `bridge.ts` (`bridge_health` + a “Test Freighter signing (no funds)”
action that builds an owner→owner 1 XLM payment with sequence 0), `submit.ts`
(static importability only).

## 10. Running a transaction from a panel

> Step W0d. A panel that builds its own unsigned XDR (Security, Schedules, P2P,
> Anchor) pushes it through the **same** approve → sign → submit pipeline the
> voice payment uses, via `app/src/lib/txPipeline.ts`. A panel never signs, never
> handles a secret, and never bypasses the gate.

- `runTx(result, { intent, label })` — takes a `ChainToolResult` from a
  `@polaris/stellar` builder, computes the digest (`xdrDigest`, exactly as the
  seam does), asks the Touch ID approver, then calls `signAndSubmit`. It never
  throws: it resolves to `{ status: "submitted", txHash, explorerUrl }` or a
  fail-closed `{ status: "denied" | "failed", label, detail }`. Deny, expiry,
  timeout, a throwing approver and sign/submit failures are all labelled outcomes.
- `runTxSequence(steps, deps?, onProgress?)` — runs steps strictly in order,
  stops at the first non-submitted outcome, and reports
  `(index, total, label, phase)` so the panel can show which step is running.
- `useTxRun()` (`app/src/lib/useTxRun.ts`) — the React hook for a panel:
  `{ state: idle|running|done, progress, outcomes, run(steps), reset() }`.
- Deps (approver, signer, clock) are injectable; the defaults lazily compose the
  real `createTouchIdApprover` and `signAndSubmit`, so no Tauri code loads until a
  panel actually runs a transaction. `docs/ui-panels.md` rules still hold: the
  digest is the XDR digest, not the tx hash; `POLARIS_ALLOW_AUTO_APPROVE` stays
  off; a denial is final.
