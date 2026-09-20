# W15g — approval card inside the notch (no approval popup)

**What/why:** the pending-approval card no longer opens a separate window. The
notch is the only approval surface: `ShellSurface` pins the `panel` state while a
request is live and renders the card over the page body. Security semantics are
unchanged (fail-closed, one-time `take_authorized`, one Touch ID for a batch).

**Files (new):** `app/src/notch/approval/{overlayModel.ts, overlayModel.test.ts,
usePendingApproval.ts, usePolarisEvents.ts, ApprovalOverlay.tsx, ApprovalCard.tsx,
BatchApprovalCard.tsx, HashFingerprint.tsx}`.
**Files (edited):** `app/src/lib/approver.ts` (+`approver.test.ts`) — removed the
`open("approval")` call and the `open` dep; `app/src/lib/approval.ts` — added
optional `id?` to `ApprovalBatchStep` (matches the Rust snapshot; lets batch deny
go through a step id); `app/src/notch/ShellSurface.tsx` — 6 lines: hook call,
`pinned ||= approval.visible`, `voiceAttention && !approval.visible`, mount line.

**Decisions:** pure overlay state machine (`overlayModel.ts`) keeps the
approve-lock/expiry/result-dwell logic testable; a null `approval_current` clears a
pending request but never wipes a fresh result before its 2 s dwell; batch
authorize ignores the command's return (Rust returns step ids, not a snapshot) and
re-reads `approval_current`; voice attention is suppressed only while the overlay
is visible so the payment turn's `compact` proposal cannot shrink the panel.
No Rust change was needed — Rust never auto-opened the approval window (only the
webview did).

**Tests:** `npm run check` (all workspaces) clean; `npm test -w @polaris/app`
446/446 pass (new `overlayModel.test.ts` covers pending→authorizing→sent,
denied, expired, cancelled hint, failed, result-by-hash, null-snapshot dwell,
dismiss). No Rust touched, so no cargo run.

**Human-verify:** real Touch ID approve/cancel/deny, batch approve, 120 s expiry,
the result dwell + collapse on a real notch window.

**Blocked / handoff:** none. `app/src/panels/**` and the Rust `approval` panel
spec are left for the panels-deletion worker.
