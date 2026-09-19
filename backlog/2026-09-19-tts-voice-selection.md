# TTS voice selection — decisions and open items

**Date:** 2026-09-19
**Owner:** A (Fatih)
**Status:** partially decided; Turkish voice unresolved
**Related:** `backlog/2026-09-19-a3-tts.md` (implementation), step A3

## Context

Polaris speaks confirmations back to the user (step A3, Fish Audio, model `s2.1-pro-free`).
In Fish Audio the `model` header selects the *engine*; the *voice* is selected by the
`reference_id` field in the request body. Omitting `reference_id` lets the voice drift between
requests, so the owner requires a single fixed `reference_id` for every utterance
(`POLARIS_TTS_REFERENCE_ID`).

## Decided

Fish Audio's official voice set (author "Fish Official") is English-only — seven voices:
Sarah, Adrian, Selene, Ethan, Hannah, Jordan, Laura. After listening, the owner picked:

| Role | Voice | `reference_id` |
|---|---|---|
| Female (default) | Sarah | `933563129e564b19a115bedd57b7406a` |
| Male | Ethan | `536d3a5e000945adb7038665781a4aca` |

Community-uploaded Turkish voices were rejected: the most popular ones are cloned voices of
real, identifiable people (a head of state, actors). A payment assistant must not speak in a
real person's cloned voice.

## Open item 1 — no professional Turkish voice

No acceptable Turkish voice was found in the Fish Audio library. Options on the table:

1. **English-only spoken output** (recommended for the demo). Polaris still *understands*
   Turkish — A1 (on-device STT) and A2 (LLM) both handle Turkish input — it just answers in
   English with Sarah/Ethan. One voice, no drift, no accent problem.
2. **Sarah/Ethan reading Turkish text.** The engine is multilingual and will render Turkish
   with an English accent. Samples were generated for the owner to judge.
3. **macOS `Yelda` (tr_TR), already installed on the dev machine**, via the local fallback
   backend. Native pronunciation, but noticeably synthetic, and mixing it with Sarah/Ethan in
   one session means two different voices.

If option 3 or a per-language mapping is ever wanted, it needs a code change in the A3 TTS
module: a second env var (e.g. `POLARIS_TTS_REFERENCE_ID_TR`) and language detection on the
outgoing text. Not implemented — single fixed voice only.

## Open item 2 — user-facing male/female voice choice

The owner wants the **end user** to be able to pick a male or female voice in a later
milestone. Not in A3 scope. When implemented it needs:

- a setting in the app UI (not just an env var),
- persistence of the choice,
- the two ids above as the initial options,
- the "one fixed voice per session" invariant preserved — the choice changes which id is
  pinned, it must never mean "no `reference_id`".

## Constraint to remember

`s2.1-pro-free` is free until **2026-11-30** and carries **no SLA**. The local macOS fallback
must stay wired for the whole life of the demo.
