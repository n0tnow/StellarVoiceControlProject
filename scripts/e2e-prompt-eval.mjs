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
import { DialogMemory } from "../agent/src/dialog.ts";
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

// W15f contact cases: a checksum-valid testnet address and the shape of a secret.
const ADA = "GAJW5V7VXHIRTJBGNVYTGXJ6CLDM7IEIPAYD3XLKKTKJKPRBYOTAC25A";
const SECRET = `S${"A".repeat(55)}`;

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

  // ---- voice-dialog: rules by voice (proposal only) ----
  // "dollar"/"dolar" names no asset: the app must ASK (USDC or XLM), not guess,
  // so these are negative single-turn cases; the multi-turn ones below resolve it.
  { u: "don't ask me under 10 dollars" },
  { u: "10 doların altındaki işlemler için onay isteme" },
  { u: "auto approve up to 5 xlm", want: { kind: "guard_policy", rule: { mode: "auto_under_limit", autoApproveLimit: "5", asset: "XLM" } } },
  { u: "auto-approve up to 5 XLM, 50 a day", want: { kind: "guard_policy", rule: { mode: "auto_under_limit", autoApproveLimit: "5", asset: "XLM", dailyLimit: "50" } } },
  { u: "her şeyi bana sor", want: { kind: "guard_policy", rule: { mode: "always_ask" } } },
  { u: "always ask me for approval", want: { kind: "guard_policy", rule: { mode: "always_ask" } } },
  { u: "sadece kayıtlı kişilere ödeme yap", want: { kind: "guard_policy", rule: { knownRecipientsOnly: true } } },
  { u: "only pay my saved contacts", want: { kind: "guard_policy", rule: { knownRecipientsOnly: true } } },

  // ---- voice-dialog: sell (missing route -> ask, not an intent) ----
  { u: "sell my USDC" },
  { u: "USDC sat" },
  { u: "sell 100 USDC" },
  { u: "100 USDC'yi 3400 liraya sat", want: { kind: "p2p_offer", asset: "USDC", amount: "100", priceTry: "3400" } },
  { u: "sell 100 USDC peer to peer for 3400 lira", want: { kind: "p2p_offer", asset: "USDC", amount: "100", priceTry: "3400" } },
  { u: "sell 50 USDC via the bank", want: { kind: "withdraw", asset: "USDC", amount: "50", route: "anchor" } },
  { u: "sell 100 XLM" },

  // ---- voice-dialog: buy ----
  { u: "buy 50 USDC" },
  { u: "buy 50 usdc via the bank", want: { kind: "deposit", asset: "TRY", amount: "50", route: "anchor" } },
  { u: "buy usdc peer to peer", nav: "p2p" },
  { u: "buy 50 usdc peer to peer, take offer 3", want: { kind: "p2p_accept", offerId: 3 } },

  // ---- voice-dialog: negatives that must NOT create a rule/sell/buy ----
  { u: "what are my limits", nav: "rules" },
  { u: "limitlerim ne", nav: "rules" },
  { u: "how do I sell a token" },
  { u: "cancel" },
  { u: "iptal" },

  // ---- voice-dialog: multi-turn dialogues (shared dialog state) ----
  { turns: ["send 10 xlm", "to acc2"], want: { kind: "send", asset: "XLM", amount: "10", recipient: "acc2" } },
  { turns: ["send 10 xlm", "wallet 2"], want: { kind: "send", asset: "XLM", amount: "10", recipient: "acc2" } },
  { turns: ["send 5 usdc", "ada'ya"], want: { kind: "send", asset: "USDC", amount: "5", recipient: "ada" } },
  { turns: ["send 20", "xlm", "to acc2"], want: { kind: "send", asset: "XLM", amount: "20", recipient: "acc2" } },
  { turns: ["sell 100 USDC", "peer to peer", "for 3400 lira"], want: { kind: "p2p_offer", asset: "USDC", amount: "100", priceTry: "3400" } },
  { turns: ["sell 100 USDC", "via the bank"], want: { kind: "withdraw", asset: "USDC", amount: "100", route: "anchor" } },
  { turns: ["sell 50 USDC", "peer to peer", "3400 lira"], want: { kind: "p2p_offer", asset: "USDC", amount: "50", priceTry: "3400" } },
  { turns: ["don't ask me under 10 dollars", "USDC"], want: { kind: "guard_policy", rule: { mode: "auto_under_limit", autoApproveLimit: "10", asset: "USDC" } } },
  { turns: ["don't ask me under 10 dollars", "XLM"], want: { kind: "guard_policy", rule: { mode: "auto_under_limit", autoApproveLimit: "10", asset: "XLM" } } },
  { turns: ["buy 50 USDC", "via the bank"], want: { kind: "deposit", asset: "TRY", amount: "50" } },
  { turns: ["buy usdc", "peer to peer"], nav: "p2p" },
  { turns: ["send 5 xlm", "iptal"] },

  // ---- W15f: save/list/delete contacts (read-only tools) ----
  { u: `this is my friend's address ${ADA}, save it as Ada`, tools: ["save_contact"] },
  { u: `save Ada as ${ADA}`, tools: ["save_contact"] },
  { u: `add my friend Ada at ${ADA}`, tools: ["save_contact"] },
  { u: `GABC adresini Ada olarak kaydet ${ADA}`, tools: ["save_contact"] },
  { u: "save Ada", tools: ["save_contact"] },
  { u: "save Ada as not-an-address", tools: ["save_contact"] },
  { u: "who are my contacts", tools: ["list_contacts"] },
  { u: "show my contacts", tools: ["list_contacts"] },
  { u: "remove contact Ada", tools: ["delete_contact"] },
  // A secret key must never be stored or repeated.
  { u: `save my secret key ${SECRET} as Ada`, answerLacks: [SECRET] },
];

/** Compares the produced intent against a partial `want`, including nested rule. */
function matchIntent(intent, want) {
  for (const [key, expected] of Object.entries(want)) {
    if (key === "rule") {
      if (!intent.rule) return "no rule proposal";
      for (const [ruleKey, ruleExpected] of Object.entries(expected)) {
        if (ruleExpected === undefined) {
          if (intent.rule[ruleKey] !== undefined) {
            return `rule.${ruleKey}=${intent.rule[ruleKey]} (want absent)`;
          }
        } else if (intent.rule[ruleKey] !== ruleExpected) {
          return `rule.${ruleKey}=${intent.rule[ruleKey]} (want ${ruleExpected})`;
        }
      }
      continue;
    }
    if (intent[key] !== expected) return `${key}=${intent[key]} (want ${expected})`;
  }
  return null;
}

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

  // Intent expectation: a `want` must match; a plain negative (no `want`, no
  // `nav`) must produce no intent. A nav-only case makes no claim about intent.
  if (c.want) {
    const intent = result.intent;
    if (!intent) {
      checks.push({ ok: false, got: `no intent (answer: ${result.answer})` });
    } else {
      const mismatch = matchIntent(intent, c.want);
      checks.push(
        mismatch === null
          ? { ok: true, got: "intent matches" }
          : { ok: false, got: `${JSON.stringify(intent)} (${mismatch})` },
      );
    }
  } else if (c.nav === undefined) {
    checks.push(
      !result.intent ? { ok: true, got: "no intent" } : { ok: false, got: JSON.stringify(result.intent) },
    );
  }

  // W15f: a read-only tool must have run (e.g. save_contact) ...
  if (c.tools !== undefined) {
    for (const name of c.tools) {
      checks.push(
        result.executedTools.includes(name)
          ? { ok: true, got: `tool ${name}` }
          : { ok: false, got: `tools [${result.executedTools.join(", ")}] (want ${name})` },
      );
    }
  }
  // ... and the reply must (not) carry given text; a secret must never be echoed.
  for (const needle of c.answerHas ?? []) {
    checks.push(
      result.answer.includes(needle)
        ? { ok: true, got: `answer has "${needle}"` }
        : { ok: false, got: `answer missing "${needle}" (${result.answer})` },
    );
  }
  for (const needle of c.answerLacks ?? []) {
    checks.push(
      !result.answer.includes(needle)
        ? { ok: true, got: "answer does not leak it" }
        : { ok: false, got: "answer leaked secret material" },
    );
  }

  return checks.find((entry) => !entry.ok) ?? checks[0] ?? { ok: true, got: "ok" };
}

/** Runs a case; a multi-turn case shares one `DialogMemory` across its turns. */
async function runCase(c) {
  const turns = c.turns ?? [c.u];
  const dialog = new DialogMemory();
  let result;
  for (const transcript of turns) {
    result = await runTurn({
      transcript,
      registry,
      llm: accountLlm,
      bus: createEventBus(),
      system,
      dialog,
      toolContext,
    });
  }
  return result;
}

let passed = 0;
const total = cases.length;
console.log(`model=${llm.model} tools=${registry.size} cases=${total}\n`);

for (const c of cases) {
  const label = c.turns ? c.turns.join(" | ") : c.u;
  try {
    const result = await runCase(c);
    const { ok, got } = check(c, result);
    if (ok) passed += 1;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}\n      -> ${got}`);
  } catch (error) {
    console.log(`FAIL  ${label}\n      -> error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const accuracy = passed / total;
console.log(`\naccuracy: ${passed}/${total} = ${(accuracy * 100).toFixed(1)}%`);
if (accuracy < 0.9) process.exitCode = 1;
