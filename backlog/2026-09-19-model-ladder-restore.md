# 2026-09-19 — Model Ladder Restore (local-only fix)

## Status
- Done (local disk only): `docs/model-ladder.md` restored from `132b1f1^`, assignment table filled with PONG-verified models, `LOCAL.md` filled with machine/user context.
- `docs/model-ladder.md` and `LOCAL.md` are gitignored local-only files → intentionally NOT committed (verified via `git check-ignore`). `git status` is clean by design.

## Ladder assignments (verified 2026-09-19)
- L1 Senior: `opencode-go/kimi-k3` (PONG)
- L2 Mid: `opencode-go/qwen3.7-max` (PONG)
- L3 Junior: `opencode-go/qwen3.8-flash` (PONG)
- L4 Reviewer: `opencode-go/glm-5.3-flash` (PONG)

## Unreachable (do NOT assign)
- `chatgpt-web/*` — local :8000 bridge down (connection refused)
- `google/gemini-2.5-flash` — retired upstream
- `groq/llama-3.3-70b-versatile` — no access
- Local ollama — not installed

## PONG evidence
```
> build · glm-5.3-flash  →  PONG
> build · kimi-k3        →  PONG
> build · qwen3.8-flash  →  PONG
> build · qwen3.7-max    →  PONG
```
Verify: `caffeinate -i opencode run -m <model> "Reply with exactly: PONG"`

## Remaining work
- None for this task. Optional follow-up: revive :8000 ChatGPT bridge if chatgpt-web models are ever needed.
