# W17a — Trade deposit/withdraw on the SDF test anchor + safe fallback

**What/why.** Trade deposit/withdraw mixed scenarios: the session was built with the default
`USDC`/`TRY`, so against the default SDF anchor it asked SEP-38 for `iso4217:TRY` and got
`404 sell_asset not found`. Fixed by deriving the session from the ACTIVE scenario, and added an
up-front healthy-anchor selection (SDF first, then the TR mock) so a dead anchor fails over
before any money moves.

**Files.** `stellar/src/anchor/selection.ts` (new, pure: `approvedAnchorCandidates`,
`preflightAnchor`, `selectAnchor`, `NoHealthyAnchorError`, `NO_ANCHOR_MESSAGE`), its export in
`stellar/src/anchor/index.ts`, test `stellar/src/anchor/__tests__/selection.test.ts`;
`app/src/lib/bankAnchor.ts` (select-once + scenario session, `activeAnchorInfo`,
`anchorSelectionDetails`); `app/src/notch/trade/useAnchorTrade.ts` + `AnchorTrade.tsx` ("via …"
caption, scenario fiat/asset labels, Details toggle); `docs/anchor-sdf-flow.md`.

**Decisions.** Selection is SEP-1 + SEP-6 `/info` supported-asset only (SEP-24 never used),
6 s budget, cached once per shell; no fallback is attempted after the bank debit/payment (the
flow keeps its refund-on-failure). The chosen scenario supplies asset pair, fiat label, wallet
balance asset and trustline; the demo ledger's label is synced to the scenario fiat.

**Verification.** `npm run check` (all workspaces) clean. `test:anchor` 219/219 (8 new selection
tests: first healthy wins, first fails→second, both fail→`NoHealthyAnchorError`, asset-not-enabled,
candidate ordering/defaults). App `npm test` 412/412. No Rust touched. Live preflight-only smoke
(no funds moved): `selectAnchor(approvedAnchorCandidates())` → chosen `testanchor.stellar.org`
`SRT`/`USD`, health ok.

**Human-verify (not automated):** real Trade deposit/withdraw through Touch ID on the SDF anchor;
fallback UI when an anchor is down; the bank currency relabel on first open.

**Blocked / handoff.** None. Voice deposit/withdraw share the selection via `runBankIntent`.
