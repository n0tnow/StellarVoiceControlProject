# Review 2 — `feat/ui-tasks-rules-pro` (HEAD `81378ee`)

**APPROVE WITH CHANGES**

Independent re-review of the last commit only (`fix(ui): owner-scoped snapshot cache, stale-safe refresh, cleaner Tasks/Rules visuals`). Time-boxed fast pass.

Scope reviewed: `git show HEAD` diff (`snapshotCache.ts`, `snapshotCache.test.ts`, `useTasksData.ts`, `useRulesEditor.ts`, `TasksPage.tsx`, `RulesEditor.tsx`, `tasks-rules.css`) plus the owner mechanism it depends on (`walletSessionLive.ts`, `walletSession.ts`, `useWalletSession.ts`, `stellar_config.rs`).

Verified:
- `npm test -w @polaris/app` → **492 pass / 0 fail / 0 cancelled** (new `snapshotCache.test.ts` = 7 pass, all substantive).
- `npm run check -w @polaris/app` (tsc) → **exit 0**.

---

## Blocking issues

1. **Rules page and value-moving actions fail closed in a build without the wallet-session engine (env owner still configured).**
   - `app/src/notch/rules/useRulesEditor.ts:84-85` — `useActiveOwner()` returns `walletSessionStore...active?.address ?? null`. When the wallet engine is absent, `walletSessionStore.start()` gets `available === false` and the session stays `null` forever (`walletSession.ts:251-253`), so `owner` is **always null** here.
   - Meanwhile the loaded snapshot's owner comes from `getStellarConfig().ownerAddress`, which is the `POLARIS_OWNER_ADDRESS` env owner when no wallet is active (`app/src-tauri/src/stellar_config.rs:220-239,255-257`). That is a **valid, intended** configuration: `useWalletLocked()` deliberately does **not** gate the pages when `available === false` (`walletSession.ts:72-74`, `useWalletSession.ts:31-35`).
   - Consequences with `owner === null`, `security.owner === "<env owner>"`:
     - `useRulesEditor.ts:286` — `security` is gated to `null`, so `RulesEditor.tsx:128-270` falls past `state === "loading"` and `security !== null` into the "Rules unavailable" fallback: the rules never render.
     - `useRulesEditor.ts:255-256` — `if (!security || security.owner !== liveOwner) return;` returns early, so **Save / Turn off automatic payments are silent no-ops**.
   - This is a regression vs. the pre-fix behavior, which used `config.ownerAddress` directly and worked in env-owner builds. It contradicts the "demo mode / no wallet engine must not lock the user out" policy (`walletSession.ts:66-74`).
   - Minimal fix: only enforce the cross-owner guard when a live wallet owner is actually known.
     - `useRulesEditor.ts:255-256`: `const liveOwner = walletSessionStore.getSnapshot().session?.active?.address ?? null; if (!security || (liveOwner !== null && security.owner !== liveOwner)) return;`
     - `useRulesEditor.ts:286`: `security: security !== null && (owner === null || security.owner === owner) ? security : null`
   - Account-switch protection is preserved: when a wallet owner exists (`owner !== null`) a mismatch is still blocked; the in-app cache key + `clear()` already prevent cross-owner data, and the env owner cannot change inside the app.

## Non-blocking notes

- **Tasks page: no cache seeding for the same env-owner/no-wallet build.** `app/src/notch/data/useTasksData.ts:160-164` (`seedKeyFor`) only accepts a stored key whose owner half equals `owner`; with `owner === null` and a stored key of `"<env owner>|<network>"` it returns `null`, and `requestedKey` falls back to `PREVIEW_KEY` (`useTasksData.ts:229`). Data still loads (`loadTasks` ignores the key), so no functional break, but every remount shows the skeleton again instead of painting the cached rows — the SWR win is lost for this config. Optional follow-up.
- **`snapshotCache` superseded-read footgun (latent, not currently triggered).** `app/src/notch/data/snapshotCache.ts:64-71`: a superseded successful read still returns `result.value` to its callers (only the cache write is skipped), and a superseded failed read returns `{ value: null, stale: false, error }`. A future non-cancelled consumer (two live mounts sharing the cache) could mistake that for a first-read failure and wipe good rows. Safe today because the only force-caller is the effect that cancels its predecessor.
- **Owner-key mechanism is real, not a stub.** `walletSessionStore` is the genuine Tauri-bound store (`walletSessionLive.ts:27-43`), started by the shell via `useWalletSession` (`ShellSurface.tsx:85` → `useWalletSession.ts:20-22`), and Rust makes `stellar_config.ownerAddress` equal the active wallet address when unlocked (`stellar_config.rs:290-300`), so `scopeKey(config.ownerAddress, network)` and `useActiveOwner()` agree in the wallet-present path. `scopeOwner` parsing is safe (`|` cannot appear in a Stellar address).
- **Cache correctness (items 1–3) is sound.** Key is `owner|network` (`useTasksData.ts:134-136`, `useRulesEditor.ts:69-71`); `peek` returns `null` on any key mismatch (`snapshotCache.ts:89-92`); `clear()` bumps `generation` and drops the in-flight, and a late result cannot write (`snapshotCache.ts:105-109`, covered by the "clear drops … late in-flight" test); `force` supersedes a pre-mutation read via the generation guard (`snapshotCache.ts:64-70,97-103`); failed revalidation keeps the last good entry (`snapshotCache.ts:69-71`). The 7 tests assert real behavior (dedupe call-count, synchronous peek, key mismatch, force-wins, keep-last-good, first-failure, clear) — not tautological.
- **No visual/link regressions.** The 1px `dashed` borders on the shared `task-new` / `rule-add` primitives (`app/src/index.css:724,865`) are overridden with solid/tinted surfaces scoped to `.nr-page` (`tasks-rules.css:130-143`), and both pages carry `.nr-page` (`TasksPage.tsx:164`, `RulesPage.tsx:20`). No `window.open`/`target="_blank"`/popups added.
- **Action refresh loops intact.** Tasks `cancel`/`create` and Rules `run` still call `refresh()` on submit/executed (`useTasksData.ts:341,371`, `useRulesEditor.ts:264`); `dirty` guards the form from being clobbered by a background refresh (`useRulesEditor.ts:113,266-278`).

**Merge recommendation:** fix blocking issue 1 (2-line guard) before merging; everything else in the diff is good to go.
