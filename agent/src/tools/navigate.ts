/**
 * `navigate` — open a screen by voice (NAV).
 *
 * "Cüzdanı aç" / "show my rules" is not a value-moving intent: the tool runs
 * during the turn, needs no approval and produces no `Intent`. Its result is a
 * `NavigationRequest` (a TypeScript-only seam, `@polaris/interfaces`) that the
 * shell turns into a notch page or a panel window. The tool owns the
 * deterministic spoken confirmation, so the loop never makes a second model
 * turn — the same pattern `get_balance` uses.
 */
import { NAVIGATION_TARGETS, type NavigationRequest, type NavigationTarget } from "@polaris/interfaces";

import { languageBase } from "../language.ts";
import type { AgentTool } from "./registry.ts";

/**
 * Folds a spoken word to a lookup key: lowercase, Turkish diacritics and the
 * dotless `ı` stripped to ASCII, whitespace collapsed. Turkish is the product's
 * first language, so the fold is deliberately Turkish-aware.
 */
export function foldNavigationWord(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ı/g, "i")
    .replace(/\s+/g, " ");
}

/**
 * Spoken synonyms (Turkish and English) for each canonical target. The model is
 * asked for a canonical value, but STT garbles and users mix languages, so the
 * tool normalises before validating instead of rejecting a recognisable word.
 */
const SYNONYMS: Readonly<Record<string, NavigationTarget>> = {
  wallet: "wallet",
  cuzdan: "wallet",
  cuzdanim: "wallet",
  "benim cuzdanim": "wallet",
  "my wallet": "wallet",
  hesap: "wallet",
  balance: "wallet",
  bakiye: "wallet",

  rules: "rules",
  rule: "rules",
  kural: "rules",
  kuralar: "rules",
  kurallar: "rules",
  limit: "rules",
  limitler: "rules",
  "guard rules": "rules",
  guardrails: "rules",
  policies: "rules",
  policy: "rules",
  politika: "rules",
  politikalar: "rules",

  tasks: "tasks",
  task: "tasks",
  gorev: "tasks",
  gorevler: "tasks",
  "scheduled payments": "tasks",
  "scheduled payment": "tasks",
  scheduled: "tasks",
  "zamanlanmis odemeler": "tasks",
  zamanlanmis: "tasks",
  "zamanli odemeler": "tasks",

  history: "history",
  gecmis: "history",
  "islem gecmisi": "history",
  transactions: "history",
  islemler: "history",

  security: "security",
  guvenlik: "security",
  "guvenlik ayarlari": "security",

  schedules: "schedules",
  zamanlamalar: "schedules",
  planlanmis: "schedules",

  suggestions: "suggestions",
  oneri: "suggestions",
  oneriler: "suggestions",

  anchor: "anchor",
  banka: "anchor",
  bank: "anchor",
  fiat: "anchor",
  "on ramp": "anchor",
  "on-ramp": "anchor",
  "off ramp": "anchor",
  "off-ramp": "anchor",
  "para yatir": "anchor",
  "para cek": "anchor",

  p2p: "p2p",
  ilan: "p2p",
  ilanlar: "p2p",
  escrow: "p2p",
  "peer to peer": "p2p",

  privacy: "privacy",
  gizlilik: "privacy",
  "gizli odeme": "privacy",
  "gizli odemeler": "privacy",
  "private payments": "privacy",
  confidential: "privacy",

  settings: "settings",
  ayar: "settings",
  ayarlar: "settings",

  debug: "debug",
  "hata ayikla": "debug",
  "hata ayiklama": "debug",
  diagnostics: "debug",

  close: "close",
  "close this": "close",
  "close it": "close",
  kapat: "close",
  "kapat bunu": "close",
  "kapat sunu": "close",
  dismiss: "close",
};

/** The canonical target for a spoken word, or `undefined` when unrecognised. */
export function normalizeNavTarget(value: unknown): NavigationTarget | undefined {
  if (typeof value !== "string") return undefined;
  return SYNONYMS[foldNavigationWord(value)];
}

/** Raw model input: the enum target plus the reply language. */
export interface NavigateInput {
  target?: unknown;
  language?: unknown;
}

/** What `run` returns; `spoken` is the exact sentence the loop says. */
export interface NavigationResult {
  /** Present only when the target was recognised. */
  request?: NavigationRequest;
  /** The exact sentence the loop speaks: a confirmation or a short question. */
  spoken: string;
}

const CONFIRMATIONS: Readonly<Record<NavigationTarget, { en: string; tr: string }>> = {
  wallet: { en: "Opening your wallet.", tr: "Cüzdanı açıyorum." },
  rules: { en: "Opening your rules and limits.", tr: "Kuralları ve limitleri açıyorum." },
  tasks: { en: "Opening your scheduled payments.", tr: "Zamanlanmış ödemeleri açıyorum." },
  history: { en: "Opening your history.", tr: "Geçmişi açıyorum." },
  security: { en: "Opening security.", tr: "Güvenliği açıyorum." },
  schedules: { en: "Opening your schedules.", tr: "Zamanlamaları açıyorum." },
  suggestions: { en: "Opening suggestions.", tr: "Önerileri açıyorum." },
  anchor: { en: "Opening the bank on/off ramp.", tr: "Banka işlemlerini açıyorum." },
  p2p: { en: "Opening P2P offers.", tr: "P2P ilanlarını açıyorum." },
  privacy: { en: "Opening private payments.", tr: "Gizli ödemeleri açıyorum." },
  settings: { en: "Opening settings.", tr: "Ayarları açıyorum." },
  debug: { en: "Opening debug.", tr: "Hata ayıklamayı açıyorum." },
  close: { en: "Closing.", tr: "Kapatıyorum." },
};

/** The deterministic confirmation sentence for a recognised target. */
export function navigationSentence(target: NavigationTarget, language?: string): string {
  const entry = CONFIRMATIONS[target];
  return languageBase(language) === "tr" ? entry.tr : entry.en;
}

/** Said when the model named a screen this build does not have. */
function unknownSentence(language?: string): string {
  return languageBase(language) === "tr"
    ? "Hangi sayfayı açayım?"
    : "Which page should I open?";
}

function spokenLanguage(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export const navigateTool: AgentTool<NavigateInput, NavigationResult> = {
  name: "navigate",
  description:
    "Open a screen in the app (wallet, rules, tasks, history, security, schedules, suggestions, anchor, p2p, privacy, settings, debug) or close the open one. Read-only: it moves no value and needs no approval.",
  inputSchema: {
    type: "object",
    properties: {
      target: {
        type: "string",
        enum: [...NAVIGATION_TARGETS],
        description:
          "The screen to open, or 'close' to close the current surface. Use only these values.",
      },
      language: {
        type: "string",
        description:
          'The language the user spoke, as a BCP-47 base code ("tr" or "en"). ' +
          "Used to phrase the spoken confirmation; never spoken itself.",
      },
    },
    required: ["target"],
    additionalProperties: false,
  },
  async run(input: NavigateInput): Promise<NavigationResult> {
    const language = spokenLanguage(input?.language);
    const base = languageBase(language);
    const target = normalizeNavTarget(input?.target);
    if (!target) {
      return { spoken: unknownSentence(language) };
    }
    const spoken = navigationSentence(target, language);
    return {
      request: { target, spoken, ...(base ? { language: base } : {}) },
      spoken,
    };
  },
  toSpeech(output: NavigationResult): string {
    return output.spoken;
  },
  toNavigation(output: NavigationResult): NavigationRequest | undefined {
    return output.request;
  },
};
