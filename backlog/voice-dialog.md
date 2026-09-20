# voice-dialog — memory, rules by voice, sell/buy routing

**Branch:** `feat/voice-dialog`. **Status:** open (review).

## What / why
The agent was stateless per utterance, `guard_policy` had no voice tool, and there
was no sell concept. This adds the layer without inventing new chain actions.

- **Dialog memory** (`agent/src/dialog.ts`, wired in `loop.ts`; instance in
  `app/src/lib/agent.ts`): last ≤4 exchanges + one pending clarification
  (`{kind, filledSlots, missing, expiresAt:+90 s}`) go into the model prompt; a
  tool that cannot fill a slot throws `AgentError.pending` and the loop asks one
  short question. Reset on timeout, on a produced/refused intent, and on
  `cancel/iptal/vazgeç/never mind`. Memory only, no secrets.
- **`set_approval_rule`** (`tools/rule.ts`): a `guard_policy` intent with an
  additive `Intent.rule` payload. "dollar/dolar" with no asset asks USDC or XLM.
  Proposal only: `chain.ts` labels it "Autonomous rules aren't enabled in this
  build yet."; the Security panel path is untouched.
- **`sell_asset`/`buy_asset`** (`tools/sell.ts`) map to existing executors:
  sell+anchor→`withdraw` (USDC only), sell+p2p→`p2p_offer` (asks TRY price),
  buy+anchor→`deposit`, buy+p2p→open P2P offers or `p2p_accept` with an id.
  Missing route asks one question. Additive `AgentTool.toNavigationFor` gives the
  gated buy tool a read-only branch. Prompt taxonomy in `capabilities.ts`.

## Verification
- `npm run check` green; `npm test -w @polaris/agent` 213/213;
  `npm test -w @polaris/app` 385/385; `npm run build -w @polaris/app` green.
- Live `e2e:prompt` (90 cases, +36 incl. 12 multi-turn): **90/90 = 100%** with
  `POLARIS_AGENT_PROVIDER=openai POLARIS_AGENT_MODEL=glm-5.3-flash` (env override,
  no `.env` edit); the `.env` Anthropic key is out of credit (HTTP 400). Rust
  untouched. Human-only, unverified: mic/STT, Touch ID, the rule proposal on the
  approval card, real windows.

## Handoff
Rule execution is a separate task. `buy+anchor` treats the spoken amount as TRY.
`turnFlow.ts` left to the concurrent wallet-gate worker.
