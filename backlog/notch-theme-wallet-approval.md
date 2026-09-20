# notch-theme-wallet-approval — the wallet-unlock and approval cards now use the notch's page theme

**Status:** done (code + typecheck + tests + build verified). Not committed/pushed (coordinator's job). Human visual pass on a real notch + Touch ID still advisable.

**Branch / worktree:** `fix/notch-theme-wallet-approval` in `.worktrees/notch-theme-wallet-approval`.

---

## 1. Problem

Two surfaces did not belong to the notch's "main theme" (History / Tasks / Rules / Settings / Trade):

1. **Wallet unlock card** (`UnlockScreen`) — a navy, hard-bordered `CARD` (`border-polaris-line bg-polaris-panel/40`), a saturated magenta `ring-1` on the selected account row, and a sky-blue primary button.
2. **Approval card** (`ApprovalCard` / `BatchApprovalCard`) — a navy `rounded-xl border border-polaris-line bg-polaris-panel p-4 shadow-2xl` box, sky-blue primary button, and, while visible, the whole notch lost its rounded bottom corners and the page behind was smeared by `backdrop-blur-sm`.

---

## 2. Root cause of the square corners (found + fixed)

`.notch` rounds its bottom corners via `border-radius: var(--shell-bottom-radius)` and `.notch-panel` restates that bottom radius, **but `.notch-panel` had no `overflow` clipping**. `ApprovalOverlay` was `absolute inset-0 bg-black/60 backdrop-blur-sm` with **no radius**, so its square border-box painted a semi-transparent black rectangle (and a rectangular `backdrop-filter` region) over the shell's rounded corner cut-outs; the CSS radius was visually overridden. The overlay being `inset-0` also covered the left nav, hiding the **Close** entry during an approval.

**Fix (index.css):**

- `.notch-panel { overflow: hidden; }` — every child, including the overlay, is now clipped to the shell's rounded panel shape. This is the durable invariant: an overlay can no longer paint past the notch.
- `.approval-overlay` replaces the inline Tailwind overlay: it covers **only the page column** (`left: var(--panel-nav-width)`), uses the shell's own `background: #000`, shares `.panel-body`'s padding, and **drops `backdrop-blur`** entirely. The nav and its Close entry stay visible and clickable in every state.
- Added `--panel-nav-width: 128px` on `.notch-panel` and reused it for the `.notch-panel-inner` grid and the overlay's left edge, so the two cannot drift.

---

## 3. Changed files

| File | One-line reason |
|---|---|
| `app/src/index.css` | Added `overflow: hidden` + `--panel-nav-width` to `.notch-panel`; new `.approval-overlay`; used the var in `.notch-panel-inner`; `.wallet-key` became button-safe with a neutral `.is-selected`/hover surface. |
| `app/src/components/ui/button.tsx` | Added two notch-palette variants: `notch` (near-white primary) and `notchOutline` (white-alpha outline). |
| `app/src/notch/wallet/UnlockScreen.tsx` | Rebuilt the card from `rule-card` / `rule-head` / `rule-icon` / `rule-name` / `rule-body` / `rule-condition` + `wallet-key` rows; neutral selected row; `Button variant="notch"`. |
| `app/src/notch/approval/ApprovalCard.tsx` | Card → `rule-card`, progress bar → existing `.wallet-budget-bar` (accent), labels/rows/details/hint → notch tokens, buttons → `notch` / `notchOutline`. |
| `app/src/notch/approval/BatchApprovalCard.tsx` | Same treatment as the single card, so the two approval surfaces cannot look different. |
| `app/src/notch/approval/ApprovalOverlay.tsx` | Overlay uses the new `.approval-overlay` class (page-column only, no blur, opaque black). |
| `app/src/notch/approval/HashFingerprint.tsx` | Payload-hash row lost its navy border for the notch's muted surface + tokens. |

Scope check: no contracts / agent / stellar / scripts / Rust / docs touched. `git status` lists only the files above plus `backlog/assets/notch-theme/` (screenshots) and this report + the `backlog.md` index line.

---

## 4. Before → after style mapping

| Element | Before | After |
|---|---|---|
| Unlock card surface | `CARD`: `border border-polaris-line bg-polaris-panel/40` (navy + border) | `rule-card`: `background #ffffff08`, `border-radius 11px`, no border — same material as Rules/LoginGate/Tasks |
| Unlock title | `<h2 text-sm font-semibold>` with ad-hoc accent icon | `rule-head` + `rule-icon` (accent) + `rule-name` |
| Unlock hint | `HINT` = `text-polaris-muted` | `rule-body` + `rule-condition` = `--color-notch-muted` |
| Account row (selected) | `ring-1 ring-[var(--color-notch-accent)]` (saturated magenta outline) | `wallet-key.is-selected` → `#ffffff14` (the nav's active surface) |
| Unlock button | `Button` default = `bg-polaris-accent-strong` (sky-blue) | `Button variant="notch"` = `bg-notch-text text-black` (the onboarding's primary) |
| Approval card | `rounded-xl border border-polaris-line bg-polaris-panel p-4 shadow-2xl` | `rule-card space-y-3` (no border, no shadow) |
| Approval title/subtitle | `text-base` / `text-polaris-muted` | `text-sm font-semibold` / `text-notch-muted` |
| Approval key/value rows | `text-polaris-muted` / `font-mono text-polaris-text` | `text-[10px] uppercase text-notch-muted` / `font-mono text-[11.5px] text-notch-text` |
| Details + hint boxes | `rounded-md border border-polaris-line bg-black/20` | `rounded-lg bg-black/40` (borderless inset) |
| Details toggle | `text-polaris-muted hover:text-polaris-text` | `text-notch-muted hover:text-notch-text` |
| Timer/progress bar | `bg-white/10` + `bg-polaris-accent` (sky-blue) | `.wallet-budget-bar` → track `#ffffff1f`, fill `--color-notch-accent` |
| Approve button | `Button` default (sky-blue) | `Button variant="notch"` (near-white) |
| Deny button | `Button variant="outline"` (`border-polaris-line`, navy) | `Button variant="notchOutline"` (`border-white/15`, notch text) |
| Approval overlay | `absolute inset-0 bg-black/60 backdrop-blur-sm` (square corners, blur, covered the nav) | `.approval-overlay`: page column only, `background #000`, no blur, clipped by `.notch-panel` |
| Hash fingerprint | `border border-polaris-line bg-black/20 text-polaris-*` | `rounded-lg bg-black/40` + notch tokens |

No new hard-coded hex colours: the only literals are the white-alpha surfaces/radii the menu pages already use (`#ffffff08` / `#ffffff14` / `#ffffff1f` / `#ffffff15`-equivalent `border-white/15`) and the notch tokens.

---

## 5. Commands run (real output tails)

Dependencies were absent in the worktree, so first `caffeinate -i npm install` → `added 129 packages ... found 0 vulnerabilities`.

**Typecheck — `caffeinate -i npm run check --workspaces --if-present`**
```
> @polaris/interfaces@0.1.0 check
> tsc -p tsconfig.json
> @polaris/agent@0.1.0 check
> tsc -p tsconfig.json
> @polaris/stellar@0.1.0 check
> tsc -p tsconfig.json
> @polaris/app@0.1.0 check
> tsc -p tsconfig.json
```
(no diagnostics; exit 0)

**Tests — `caffeinate -i npm test -w @polaris/app`**
```
ℹ tests 475
ℹ suites 0
ℹ pass 475
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1370.506125
```

**Build (verifies Tailwind compiled the new tokens/utilities) — `caffeinate -i npm run build -w @polaris/app`**
```
✓ built in 532ms
```
Post-build grep of `app/dist/assets/src-*.css` confirms `.approval-overlay`, `.wallet-key.is-selected`, `--panel-nav-width` and the `bg-notch-text` utility are emitted.

**Lint:** there is **no lint script** in the repo (`package.json` / `Makefile` / workspaces contain none; `scripts/check.sh` runs tsc + tests + vite build + cargo). Nothing to run; stated plainly rather than inventing a command. Rust untouched, so `cargo check` was not run.

---

## 6. Screenshots

`backlog/assets/notch-theme/unlock-card.png` and `approval-card.png`.

Honest caveat: the live Tauri app cannot be rendered headlessly in this environment (the notch geometry, wallet session and Touch ID all come from the Rust shell). The screenshots are a **CSS harness**: the project's own compiled stylesheet (`app/dist/assets/src-*.css`) linked into a hand-written page that reproduces the exact component markup/classes inside a real `.notch.shell-panel` with the panel-state geometry (`--shell-width 660`, `--shell-height 420`, `--shell-bottom-radius 18`, `--cutout-height 34`), screenshotted with headless Chrome. They faithfully show the CSS result (rounded bottom corners against a grey backdrop, visible Close, notch surfaces/accents) but are not a capture of the running shell.

---

## 7. Not verified / discrepancies

- **"Use a different wallet" link:** the brief describes a plain text link against the unlock button, but that string does not exist anywhere in the repo (`grep -ri "different wallet"` over `app/`, `interfaces/`, `agent/`, `stellar/` → none). The current unlock screen ends at the "Unlock with Touch ID" button, so there was no spacing to fix. The other brief labels ("Log in to Autonomy", "Account 1 GDRA…I7GF") also do not literally match the code (it says "Log in to Polaris"); treated as description of the same surfaces.
- Real Touch ID unlock/approve, live notch rounding on a physical notched display, and the timer animation over a real 120 s TTL were **not** exercised (no Tauri runtime here).
- `Button`'s base focus ring is still `ring-polaris-accent/60` (sky-blue) for every variant; left unchanged to avoid touching unrelated surfaces.

## 8. Remaining work

- Human pass on a real Mac: launch (auto-opens the locked Wallet), Touch ID unlock, and a spoken send to see the approval card with the nav/Close present and rounded corners.
- If the team wants full notch-token parity, migrate the remaining `Button` default/outline call sites in the wallet/trade forms (out of this task's scope) and the base focus ring.
