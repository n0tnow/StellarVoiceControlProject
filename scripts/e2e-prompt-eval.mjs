// F2 acceptance driver — live evaluation of the system prompt (not part of CI).
//
//   npm run e2e:prompt
//
// It runs every utterance below through the REAL configured provider using the
// exact prompt, account table and transcript normalisation the shell uses, then
// scores the resulting intent or clarification. It needs the gitignored root
// `.env` (provider key); the key is read from the environment and never printed.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createEventBus } from "../agent/src/events.ts";
import { runTurn } from "../agent/src/loop.ts";
import { createAgentRuntime } from "../agent/src/runtime.ts";
import { buildSystemPrompt } from "../agent/src/capabilities.ts";
import { AccountRefLlm } from "../agent/src/accountRefs.ts";

const here = dirname(fileURLToPath(import.meta.url));
const committed = JSON.parse(
  readFileSync(join(here, "../stellar/config/aliases.json"), "utf8"),
);

function parseAliases(raw) {
  const out = {};
  for (const part of (raw ?? "").split(",")) {
    const [name, address] = part.split("=");
    if (name?.trim() && address?.trim()) out[name.trim().toLowerCase()] = address.trim();
  }
  return out;
}

const aliases = {
  ...Object.fromEntries(Object.entries(committed).map(([name, entry]) => [name, entry.address])),
  ...parseAliases(process.env.POLARIS_ALIASES),
};
const ownerAddress = process.env.POLARIS_OWNER_ADDRESS?.trim() || null;

const { registry, llm } = createAgentRuntime();
const system = buildSystemPrompt({ tools: registry.definitions(), ownerAddress, aliases });
const accountLlm = new AccountRefLlm(llm, aliases);
const toolContext = { aliases: { ...aliases } };

const cases = [
  { u: "acc1'den acc2'ye 10 XLM gönder", want: { amount: "10", asset: "XLM", recipient: "acc2" } },
  { u: "wallet 1'den wallet 2'ye 10 XLM gönder", want: { amount: "10", asset: "XLM", recipient: "acc2" } },
  { u: "send 10 xlm from wallet 1 to wallet 2", want: { amount: "10", asset: "XLM", recipient: "acc2" } },
  { u: "hesap 2'ye 25 dolar gönder", want: { amount: "25", asset: "USDC", recipient: "acc2" } },
  { u: "cüzdan 2'ye 5 XLM gönder", want: { amount: "5", asset: "XLM", recipient: "acc2" } },
  { u: "ikinci hesaba 3 xlm yolla", want: { amount: "3", asset: "XLM", recipient: "acc2" } },
  { u: "iki numaralı hesaba 7 xlm gönder", want: { amount: "7", asset: "XLM", recipient: "acc2" } },
  { u: "ek 2'ye on XLM gönder", want: { amount: "10", asset: "XLM", recipient: "acc2" } },
  { u: "AC2'ye 4 xlm gönder", want: { amount: "4", asset: "XLM", recipient: "acc2" } },
  { u: "a c c 2'ye 6 xlm gönder", want: { amount: "6", asset: "XLM", recipient: "acc2" } },
  { u: "O 2'ye 8 XLM gönder", want: { amount: "8", asset: "XLM", recipient: "acc2" } },
  { u: "10 xlm gönder acc2'ye", want: { amount: "10", asset: "XLM", recipient: "acc2" } },
  { u: "acc2'ye yarım dolar gönder", want: { amount: "0.5", asset: "USDC", recipient: "acc2" } },
  { u: "hesap 2'ye 100 dolar gönder", want: { amount: "100", asset: "USDC", recipient: "acc2" } },
  { u: "birinci hesaptan ikinci hesaba 2 XLM gönder", want: { amount: "2", asset: "XLM", recipient: "acc2" } },
  { u: "ada'ya 5 xlm yolla", want: { amount: "5", asset: "XLM", recipient: "ada" } },
  { u: "bob'a 12 usdc gönder", want: { amount: "12", asset: "USDC", recipient: "bob" } },
  { u: "send 15 usdc to carol", want: { amount: "15", asset: "USDC", recipient: "carol" } },
  { u: "wallet 2'ye 9 xlm gönder", want: { amount: "9", asset: "XLM", recipient: "acc2" } },
  // NAV: clean English navigation utterances -> `navigate` with that target.
  { u: "open my wallet", nav: "wallet" },
  { u: "show my rules", nav: "rules" },
  { u: "show my scheduled payments", nav: "tasks" },
  { u: "open my history", nav: "history" },
  { u: "open settings", nav: "settings" },
  { u: "show my private payments", nav: "privacy" },
  { u: "show p2p offers", nav: "p2p" },
  { u: "open the bank ramp", nav: "anchor" },
  { u: "open security", nav: "security" },
  { u: "close this", nav: "close" },
  // NAV: Turkish synonyms.
  { u: "cüzdanı aç", nav: "wallet" },
  { u: "kuralları göster", nav: "rules" },
  { u: "geçmişi aç", nav: "history" },
  { u: "zamanlanmış ödemeleri göster", nav: "tasks" },
  { u: "ayarları aç", nav: "settings" },
  { u: "kapat", nav: "close" },
  // NAV: STT-style garbles (no diacritics) must still navigate.
  { u: "cuzdani ac", nav: "wallet" },
  { u: "kuralari goster", nav: "rules" },
  // NAV negatives: these must NOT navigate (fact questions / value-moving).
  { u: "send 10 xlm to acc2", want: { amount: "10", asset: "XLM", recipient: "acc2" }, nav: null },
  { u: "what's my balance", nav: null },
  { u: "bakiyem ne kadar", nav: null },
  // Negative: no payment intent (clarify / refuse / off-topic).
  { u: "send 30 to wallet 2" },
  { u: "send 10 xlm" },
  { u: "send xlm to wallet 2" },
  { u: "cüzdan 1'den 5 dolar gönder" },
  { u: "send a payment" },
  { u: "wallet 2'den wallet 1'e 5 xlm gönder" },
  { u: "send 10 xlm from acc2 to acc1" },
  { u: "send 10 xlm to charlie" },
  { u: "send 10 xlm to hesap 9" },
  { u: "bugün hava nasıl?" },
  { u: "what is Stellar?" },
  { u: "merhaba" },
  // Unintelligible input: no intent, one short reply (never a lecture).
  { u: "Recipients, cüzdan, hizmet, bakiye." },
  { u: "asdf qwer tqzxc hmm" },
];

function check(c, result) {
  const navigated = result.navigation?.target ?? null;
  const checks = [];

  // Navigation expectation: `nav` is a target, or `null` for "must not navigate".
  if (c.nav !== undefined) {
    if (c.nav === null) {
      checks.push(
        navigated === null
          ? { ok: true, got: "no navigation" }
          : { ok: false, got: `unexpected navigation ${navigated}` },
      );
    } else {
      checks.push(
        navigated === c.nav
          ? { ok: true, got: `navigation ${navigated}` }
          : { ok: false, got: `navigation ${navigated ?? "none"} (want ${c.nav})` },
      );
    }
  }

  // Intent expectation: a `want` (payment) must match; a plain negative (no
  // `want`, no `nav`) must produce no intent. A nav-only case makes no claim
  // about the intent.
  if (c.want) {
    const intent = result.intent;
    if (!intent) {
      checks.push({ ok: false, got: `no intent (answer: ${result.answer})` });
    } else {
      const mismatch = ["amount", "asset", "recipient"].filter((k) => intent[k] !== c.want[k]);
      checks.push(
        mismatch.length === 0
          ? { ok: true, got: "intent matches" }
          : { ok: false, got: `${JSON.stringify(intent)} (wrong: ${mismatch.join(",")})` },
      );
    }
  } else if (c.nav === undefined) {
    checks.push(
      !result.intent ? { ok: true, got: "no intent" } : { ok: false, got: JSON.stringify(result.intent) },
    );
  }

  return checks.find((entry) => !entry.ok) ?? checks[0] ?? { ok: true, got: "ok" };
}

let passed = 0;
console.log(`model=${llm.model} tools=${registry.size} cases=${cases.length}\n`);

for (const c of cases) {
  try {
    const result = await runTurn({
      transcript: c.u,
      registry,
      llm: accountLlm,
      bus: createEventBus(),
      system,
      toolContext,
    });
    const { ok, got } = check(c, result);
    if (ok) passed += 1;
    console.log(`${ok ? "PASS" : "FAIL"}  ${c.u}\n      -> ${got}`);
  } catch (error) {
    console.log(`FAIL  ${c.u}\n      -> error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const accuracy = passed / cases.length;
console.log(`\naccuracy: ${passed}/${cases.length} = ${(accuracy * 100).toFixed(1)}%`);
if (accuracy < 0.9) process.exitCode = 1;
