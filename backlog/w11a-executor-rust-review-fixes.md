# W11a-fix — apply the executor security review

**What/why.** Applied every finding in `backlog/w11a-executor-rust-review.md` so
no unprompted signer is fail-open on cost, input or authorization shape.

**Files.**
- `app/src-tauri/src/wallet/executor.rs`: MAJOR-1 fee/resource/precondition/memo
  checks + `PayCaps`; MAJOR-2 16 KiB input cap + `Limits { depth: 32, len: 64 KiB }`;
  MINOR-3 auth `root_invocation` must equal the op with empty sub-invocations;
  MINOR-4 atomic `executor_create`; NIT-1 `read_seed` follows the owner's recorded
  store kind; NIT-3 per-asset decimals; tests.
- `app/src-tauri/src/wallet/mod.rs`: MINOR-2 `remove` drops the executor seed and
  `executors[owner]`.
- `app/src-tauri/src/approval.rs` + `app/src-tauri/src/wallet/session.rs`:
  MINOR-1 `deny`/`invalidate_for_lock` return every step hash and the commands
  emit one event per hash; NIT-2 batch `approval_request` carries the batch id,
  not an empty hash.
- `app/src-tauri/src/stellar_config.rs`: `POLARIS_ASSET_DECIMALS` parser/reader.
- `backlog/w11a-executor-rust.md`.

**Decisions.**
- Fee cap `POLARIS_AUTOPAY_MAX_FEE_STROOPS` default 2 XLM, downward-only; Soroban
  `resource_fee` ≤ 1 XLM; time window ≤ 300 s.
- NIT-3: the whole-unit cap is scaled by the moved asset's configured decimals;
  an asset missing from `POLARIS_ASSET_DECIMALS` (format `hex64=decimals,…`) is
  refused, so the app must set it (testnet native SAC
  `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` →
  `d7928b72c2703ccfeaf7eb9ff4ef4d504a55a8b979fc9b450ea2c842b4d1ce61=7`).
- Scope note: MINOR-1 required touching `wallet/session.rs` (three call sites);
  no other out-of-scope file was changed.

**Verified.** `cargo test` **372 passed / 0 failed / 5 ignored** (17 executor
tests, incl. exact-cap boundary, nested `ScVal` vec/map, 128 KiB-stack decode,
concurrent creates). `cargo clippy --all-targets -- -D warnings` clean.
`npm run check` green; app **416/0**, stellar **112/0**, agent **213/0**.
`npm run e2e:autopay` → `e2e:autopay OK`.

**Remaining / human-verify.** Real Touch ID/Keychain and a live in-app
`executor_sign_pay` on a funded executor; the TS builder already sets
`setTimeout(300)` + `BASE_FEE`, so no `autopay*.ts`/guard change was needed.
