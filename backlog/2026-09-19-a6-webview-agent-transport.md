# Report: A6 — the Tauri webview cannot reach the agent proxy ("Net error")

- **Date:** 2026-09-19
- **Worker/Agent:** opencode worker (deepseek-v4.1-flash)
- **Branch/Worktree:** `feat/a4-speak-intent` / `.worktrees/a4`
- **PR:** none (task: push only, no PR, no merge, no tag)

## Objective

A spoken payment command reached the agent but never the provider: the notch
showed `NET ERROR …` and the trace stayed on `glm-5.3-flash · thinking`. Get the
real cause, fix it so the turn completes in the running app (preferably in a way
that also works packaged), and stop the notch/trace sticking on failure.

---

## 1. The ACTUAL cause (quoted from the running app)

**`fetch` was not failing for a network reason at all. It threw a `TypeError`
before any request left the process, because the client invoked the native
`Window.fetch` with the wrong receiver.**

`agent/src/llm/openai.ts` stored the global fetch in a private field and called it
as a method:

```ts
this.#fetch = options.fetchImpl ?? globalThis.fetch;   // …later…
response = await this.#fetch(`${this.baseUrl}/chat/completions`, { … });
```

Calling `this.#fetch(...)` sets `this` to the `OpenAiCompatibleLlm` instance.
WebKit — the Tauri WKWebView — enforces the WebIDL receiver for `Window.fetch`
and rejects that call. Node's `fetch` (undici) does not care, and a *direct*
`fetch(...)` call has the correct receiver, which is why the CLI and the
coordinator's browser-page check both passed while the app failed.

I captured the exact in-app message by beaconing the caught error out of the live
webview (an `<img>` GET to a temporary Vite middleware, so it survives even a
broken `fetch`). Real capture, **before** any fix:

```
{"run":{"ok":false,"failure":{"transcript":"Ahmete 5 USDC gönder",
 "label":"Net error",
 "detail":"could not reach the model provider at /agent-api: Can only call Window.fetch on instances of Window",
 "latencyMs":1}}}
```

`latencyMs: 1` is the proof it is synchronous, not network. Then I reproduced the
WebIDL rule in a bare WKWebView (same machine, `http://localhost:1420`, no Tauri):

```
NAV OK: http://localhost:1420/
PROBE: {"origin":"http://localhost:1420","href":"http://localhost:1420/",
 "unboundCall":{"ok":true,"status":200},
 "methodCall":{"error":"TypeError: Can only call Window.fetch on instances of Window",
               "name":"TypeError","message":"Can only call Window.fetch on instances of Window"},
 "post":{"ok":true,"status":200,…},
 "get":{"ok":true,"status":200},
 "ipv4":{"error":"TypeError: Load failed","message":"Load failed"}}
```

- `unboundCall` (`const f = globalThis.fetch; f('/')`) → **200**: a plain call is fine.
- `methodCall` (`{ f: globalThis.fetch }.f('/')`) → **exactly the app's error**.
- `post` to `/agent-api/chat/completions` from a bare WKWebView → **200**: the dev
  proxy, key injection and same-origin fetch were never the problem, as the
  coordinator had already shown.
- `ipv4` failing is only because Vite listens on `[::1]` (a red herring; `localhost`
  resolves to `::1` here).

So the coordinator's read was right — `fetch` itself rejects, not an HTTP status —
and the cause is a WebKit-only receiver check, not ATS, a missing capability, or
proxy interception.

## 2. The fix, and why it is the right one

Two changes, at two levels:

1. **The literal bug — `agent/src/llm/openai.ts`.** The transport is now invoked as
   a plain call, so the receiver is never the client:
   ```ts
   const fetchImpl = options.fetchImpl ?? globalThis.fetch;
   this.#fetch = (input, init) => fetchImpl(input, init);
   ```
   Regression test `the provider fetch is invoked without the client as its
   receiver (WKWebView)` fails on the old code (`this` was the client) and passes
   now (`this` is `undefined`).

2. **The transport — `app/src-tauri/src/agent.rs` (`agent_chat`).** The webview no
   longer performs provider HTTP at all. `app/src/lib/agent.ts` injects a
   `fetchImpl` that calls the Rust command; Rust reads `POLARIS_AGENT_BASE_URL` and
   `OPENCODE_API_KEY`, adds `Authorization` + `x-opencode-session` + `User-Agent`,
   POSTs to `{base}/chat/completions`, and returns `{ status, body }`. The
   TypeScript client rebuilds a `Response` from that, so request construction, the
   error taxonomy (`auth` vs `http` vs `network` vs `malformed`) and response
   parsing are all unchanged — only the transport moved.

Why this rather than patching the dev proxy: the proxy was **dev-only** (the A2
report flagged it), so fixing `openai.ts` alone would have made `npm run dev` work
and left a packaged Polaris still broken. The Rust command is the one place the
credential already lives, has no webview restriction, and needs no dev server. The
`/agent-api` proxy and the `loadEnv`-of-the-key were therefore **deleted** from
`app/vite.config.ts`; the key is now read only in Rust.

**Packaged builds:** yes, this is the packaging fix. A built app has no Vite
server, and it no longer needs one — the provider call is in the binary. Honest
limit: I verified the transport in the **dev** app (below); I did not produce and
run a `tauri build` `.app` bundle in this round.

**Secret hygiene:** `AGENT_BASE_URL` in the webview is now a logical label
(`agent+polaris://provider`); the real URL and the key are only in Rust. `grep` of
`app/dist` finds neither `OPENCODE_API_KEY` nor `opencode.ai` (the one `sk-` hit is
the substring in the CSS property `mask-type`).

## 3. The stuck notch/trace

Two defects:

- `agent/src/loop.ts` emitted `agent_status: done` only on success, so after a
  provider error the last stage stayed `thinking` forever.
- `App.tsx` had no shell state for an agent failure, so the notch had nothing to
  show and the trace was the only feedback.

Fixes:

- `runTurn` now settles its stage in a `finally` — `done` is emitted on **both**
  paths. Regression test (`a provider failure propagates and emits an error event`)
  now asserts the stages are exactly `["thinking","done"]`.
- `App.tsx` treats a failed agent turn as a shell state, exactly like a step-A1 STT
  failure: the short label is shown in the notch ear for `STT_ERROR_DWELL_MS`, then
  the shell collapses; a new recording clears it. The full detail still goes to the
  console and the trace tooltip.

Verified live (forced transport failure, DOM read back from the webview):

```
failure: label "Net error", latencyMs 5
notch:   label "Net error", class "notch is-expanded state-error",
         aria  "Net error. ⌃⌥ to retry"
trace:   "glm-5.3-flash · done"          ← was "· thinking" before
success: label "Connecting", class "notch state-idle",
         trace "glm-5.3-flash · done"
```

## 4. Live end-to-end proof (real app, real provider)

Environment: the owner's `tauri dev` was already running; its Rust watcher rebuilt
and restarted the app after the Rust change (I did **not** restart the dev server —
editing `app/vite.config.ts` made Vite restart in-process, which is normal HMR
behaviour; a working instance is left running). To read the result without a
microphone, a temporary self-test drove `runAgentTurn("Ahmete 5 USDC gönder")` — the
exact function `App.tsx` calls — and a temporary `<img>` beacon reported the result
to a Vite middleware; a second captured instance produced the Rust stdout. **All
temporary instrumentation was removed before the commit** (working tree == commit).

Rust terminal (captured stdout of the built binary):

```
polaris: loaded environment from …/.worktrees/a4/.env
polaris: STT backend on-device (tr-TR); audio never leaves this Mac
polaris: TTS backend Fish Audio (s2.1-pro-free — voice 933563129e564b19a115bedd57b7406a) with local macOS speech as fallback
polaris: notch overlay ready — hold Control+Option (or Control+Option+Space) to record; listen on `polaris-event`, network=testnet
polaris: agent → provider HTTP 200 in 2029 ms
```

Webview result of the same turn:

```
{"run":{"ok":true,"outcome":{"transcript":"Ahmete 5 USDC gönder",
 "answer":"Send 5 USDC to Ahmet.",
 "intent":{"kind":"send","asset":"USDC","amount":"5","recipient":"Ahmet",
           "source":"Ahmete 5 USDC gönder"},
 "executedTools":[],"latencyMs":2039}}}
```

**Measured intent latency inside the app:** `2039 ms` and `2387 ms` on two
successful turns (the Rust HTTP round trip was `2029 ms`); one earlier sample was
`3761 ms`, and one `13393 ms` outlier occurred while two app instances were running
during a reload — I report the whole set rather than cherry-picking. The ~2 s turns
are consistent with the A5 CLI numbers for `glm-5.3-flash`.

## 5. Exact commands and real output

```
$ caffeinate -i npm run typecheck          # interfaces, agent, stellar, app — clean
$ caffeinate -i npm run build
dist/index.html                   0.43 kB │ gzip:  0.28 kB
dist/assets/index-B1D_12nq.css   19.68 kB │ gzip:  4.82 kB
dist/assets/index-BSMXXDgG.js   237.96 kB │ gzip: 75.58 kB
✓ built in 203ms

$ caffeinate -i npm test -w @polaris/agent
# tests 40
# pass 40
# fail 0

$ caffeinate -i cargo test
test result: ok. 104 passed; 0 failed; 2 ignored; 0 measured; 0 filtered out

$ caffeinate -i cargo clippy --all-targets
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.25s
```

Test counts moved 39 → 40 (agent; new receiver regression) and 100 → 104 (Rust; four
`agent.rs` tests). No existing test was weakened.

## 6. Files changed

- **New:** `app/src-tauri/src/agent.rs`, `backlog/2026-09-19-a6-webview-agent-transport.md`
- **Modified:** `agent/src/llm/openai.ts` (+receiver fix), `agent/src/llm/openai.test.ts`
  (+regression, renamed a proxy-era test name), `agent/src/llm/config.test.ts`
  (test name), `agent/src/loop.ts` (terminal `done`), `agent/src/loop.test.ts`
  (regression), `agent/src/runtime.ts` + `agent/src/llm/openai.ts` (comments),
  `app/src/lib/agent.ts` (Rust transport), `app/src/App.tsx` (failure shell state),
  `app/vite.config.ts` (proxy + key loading removed), `app/src/vite-env.d.ts`
  (comment), `app/src-tauri/src/lib.rs` (register `agent_chat`), `.env.example`,
  `docs/architecture.md` §4.2, `backlog.md`, `notes.md`
- **Not touched / not committed:** `TASK-A4.md`, `TASK-A5.md`, `TASK-A6.md`;
  `stellar/**`, `contracts/**` (Owner B).

## 7. Unverified (stated plainly)

- **No packaged `tauri build` run.** The transport is Rust-only and the dev proxy is
  gone, so packaging should work, but that is reasoning plus a dev-mode run — not an
  observed packaged launch.
- **The human mic path is still not observed.** The live proof drives the same
  `runAgentTurn` the transcript handler calls, not a real utterance.
- **Latency is a handful of samples**, not a distribution; the provider is the free
  `glm-5.3-flash` tier and one 13.4 s outlier was seen.
- **The notch failure presentation was verified by forcing a transport failure**, not
  by a real provider outage; the dwell is 5 s, matching A1.

## 8. Suggested next step

Run `tauri build`, open the `.app`, and do the owner's real mic run
("Ahmet'e beş USDC gönder"): it should now reach the provider through Rust with no
dev server, show the intent trace, and never stick on `thinking`.
