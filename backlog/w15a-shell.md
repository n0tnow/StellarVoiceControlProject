# W15a — shell: closable panel, no "⋯" menu, voice nav into the notch

Fixed the logout dead-end; the notch is now the only surface.
Files: `notch/{ShellSurface.tsx,MoreMenu.tsx+test(delete)}`, `lib/{walletSession.ts+test,panels.ts,
navigation.ts+test}`, `index.css` (`.panel-nav*`), `docs/{ui-panels.md,notch-pages-wiring.md}` (live
docs, outside the listed scope but stale otherwise).

1. **Closable panel:** dropped `shouldPinWallet`; `closePanel` no longer early-returns. Wallet
   auto-opens on Wallet **once** at launch (ref guard), never re-forced. New `didSessionLock` +
   effect collapses the panel on the unlocked→locked (logout/auto-lock) edge. A held panel
   (launch/voice nav) is dismissable by Close, Escape **and** hover-leave (a `listenNotchHover`
   listener clears the hold; the reducer keeps its normal leave grace).
2. **"⋯" menu deleted** (`MoreMenu.tsx`+test, mount, `MORE_MENU`/`MoreMenuEntry`). Kept
   `openPanel` (approval/rules/suggestions flows) and `quitPolaris` (Settings). No popup is
   reachable from the notch.
3. **Voice nav:** every `NavigationTarget` → a notch page (tasks/schedules/suggestions→tasks,
   rules/security→rules, anchor/p2p→trade, settings/privacy/debug→settings; close→collapse).
   `applyNavigation` is a documented no-op (export kept); `panelFor` removed.
4. **Nav:** compacted `.panel-nav*` (gap 1px, 6px padding, `min-height:0; overflow:hidden`) so
   six pages + Close fit under the face header without scrolling; look unchanged.

Tests: `npm run check` clean (4 workspaces); `npm test -w @polaris/app` 432 pass / 0 fail (net −2:
3 MoreMenu tests removed, 1 added). Rust untouched. Human-verify: launch auto-open,
Close/Escape/hover-away, logout collapses and stays closed, voice targets land right.
Historical mentions of the removed names remain only in `backlog/`+`sprints.md` logs.
