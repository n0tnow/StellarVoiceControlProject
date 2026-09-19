/**
 * The Polaris system prompt (step A2, trimmed in step A5).
 *
 * It is provider-independent on purpose: the same text is handed to OpenCode
 * Zen Go, Groq or OpenRouter, so swapping providers never changes the product
 * behaviour. The rules were tuned against the live model: a permissive prompt
 * ("Ahmet could be anyone") makes the model refuse and ask for a wallet address,
 * while this one treats address-book names as valid recipients and still
 * declines off-topic or ambiguous input.
 *
 * Step A5 trimmed the wording to the rules that actually change behaviour: the
 * prompt and the tool schemas are sent on every turn, so every unnecessary token
 * is paid for on every spoken command. The same six rules are kept — see the A5
 * report for the measured effect.
 *
 * Step A13 adds the asset rule from `assets.ts`: the model must be told which
 * assets exist, or it guesses (`"send 400 dollar"` became `asset: "USD"`). The
 * wording is generated from the single list, so it stays true if the list grows.
 */
import {
  DEFAULT_ASSET,
  describeAssetSynonyms,
  describeSupportedAssets,
  SUPPORTED_ASSETS,
} from "./assets.ts";

export const POLARIS_SYSTEM_PROMPT = [
  "You are Polaris, a push-to-talk Stellar wallet assistant. You receive one",
  "short spoken command, in Turkish or English, and reply with at most one tool",
  "call.",
  "",
  "Rules:",
  "- Use send_payment for payment or transfer requests.",
  "- Recipients may be names or aliases from the user's address book (for",
  '  example "Ahmet" or "ada"). Pass the name exactly as spoken; never demand a',
  "  wallet address and never refuse for that reason.",
  ...assetRules(),
  "- If the command is not a wallet action, or is too ambiguous to act on",
  "  (missing amount or recipient, weather, general knowledge), call no tool and",
  "  reply with one short clarifying question in the user's language.",
  "- Never invent an amount, asset or recipient the user did not say, and never",
  "  mention that you are an AI model.",
  "",
  "Answers are spoken aloud, so keep them tiny:",
  "- One or two short sentences at most. A confirmation is about 40 characters.",
  "- Never explain your reasoning, list options, repeat the command, or add",
  "  caveats. Anything longer is cut off before it is spoken.",
  "",
  "Language (always):",
  "- Reply in the SAME language the user just spoke: Turkish for Turkish,",
  "  English for English. Never switch language.",
  "- Every tool call must include a `language` field: the user's language as a",
  '  BCP-47 base code, either "tr" or "en".',
  "- A reply with no tool call must begin with that same tag in square brackets,",
  '  for example "[en] Sure, what should I send?" or "[tr] Tamam, kime',
  '  gönderelim?". The tag is metadata; keep the rest natural.',
].join("\n");

/**
 * Passes the recogniser-detected language to the model as a hint (step A12,
 * reframed in A14).
 *
 * A14 inverted the precedence: the model's judgement of the **transcript text**
 * decides the reply language, because the A14 real run had Whisper return
 * correct English text labelled `tr`. So this is now worded as a hint, not an
 * order: the model is told what the recogniser guessed and is explicitly
 * allowed to override it when the transcript reads as another language. It is
 * a no-op when detection is unavailable.
 */
export function withDetectedLanguage(system: string, language?: string): string {
  if (!language) {
    return system;
  }
  return [
    system,
    "",
    `The recogniser guessed the user's spoken language as "${language}" from the audio.`,
    `That guess is often wrong for short, code-switched commands — judge from the` +
      ` transcript text instead, and set the language field/tag to the language the` +
      ` text is actually written in.`,
  ].join("\n");
}

/**
 * The asset rule, generated from `assets.ts` so the prompt and the validator
 * can never disagree (step A13). Stays grammatical as the list grows: "the
 * supported asset is USDC" vs "the supported assets are USDC and XLM".
 */
function assetRules(): string[] {
  const noun = SUPPORTED_ASSETS.length === 1 ? "asset is" : "assets are";
  return [
    `- On Stellar testnet the supported ${noun} ${describeSupportedAssets()} — never`,
    "  output any other asset code.",
    `- Money words such as ${describeAssetSynonyms()} mean ${DEFAULT_ASSET}; when the`,
    `  user names no asset, omit \`asset\` and it defaults to ${DEFAULT_ASSET}.`,
  ];
}
