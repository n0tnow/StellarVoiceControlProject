# W15f — "Ask Polaris": save a contact by text/voice

## What / why
The typed prompt (double-Control) and the voice lane can now manage the address book:
`save_contact {name, address}`, plus read-only `list_contacts` and `delete_contact`.
"this is my friend's address GABC…, save it as Ada" → the agent calls `save_contact`,
the app checksums the strkey, stores it through the existing Rust `contacts_*`
commands, dispatches `polaris:contacts-changed`, and the reply is
`Saved Ada → GAJW…C25A.` Nothing here moves value (no approval, no intent).

## Files touched
- `agent/src/tools/contact.ts` (new): the three tools, name/address normalisers,
  secret-key and recovery-phrase detection, tr/en spoken sentences.
- `agent/src/tools/registry.ts`: `ToolContext.contacts?: ContactStore`.
- `agent/src/runtime.ts`: register the three tools in the default registry.
- `agent/src/index.ts`: export the tools and types.
- `agent/src/capabilities.ts`: contact rules + few-shot examples in the prompt.
- `app/src/lib/contacts.ts`: `createAgentContactStore()` (checksum + duplicate
  guard + DOM event), injectable for tests.
- `app/src/lib/agent.ts`: inject the store into every turn's `ToolContext`.
- `scripts/e2e-prompt-eval.mjs`: 10 contact cases + `tools`/`answerHas`/`answerLacks` checks.
- Tests: `agent/src/tools/contact.test.ts` (18), `app/src/lib/contacts.test.ts` (6).

## Decisions
- Safety lives in the tool: a secret key (`S`+55 base32, spaces stripped) or a
  12/15/18/21/24-word mnemonic is refused before any store call and never echoed;
  a missing address asks the user to type it; the address shape is gated locally
  and the checksum by the shared `isValidStellarAddress` (lazy SDK import).
- Duplicate names are never overwritten: same name + same address → "already
  saved", same name + different address → "pick another name" (pre-check + a
  fail-closed catch on the Rust `exists` error).
- `save_contact` returns a `toSpeech` sentence, so the loop answers without a
  second model turn (same pattern as `navigate`/`get_balance`).

## Verification
- `npm run check` (all workspaces) clean.
- `npm test -w @polaris/agent`: 231/231 pass (18 new). `npm test -w @polaris/app`: 440/440 pass (6 new).
- Rust untouched, so no cargo run. Live `npm run e2e:prompt` not run (needs the
  provider key); the coordinator runs it. Eval script `node --check` clean.

## Human-verify / handoff
- Live eval (`npm run e2e:prompt`) for the 10 new cases.
- Real mic/voice for "save it as Ada"; a real address save appears in the Wallet
  page's recipients (the Rust `contacts_changed` event refreshes `useContacts`).
- `delete_contact`/`list_contacts` are wired but were only exercised by unit tests.
