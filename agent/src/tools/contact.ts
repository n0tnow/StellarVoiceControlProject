/**
 * `save_contact`, `list_contacts`, `delete_contact` — the address book by voice
 * or typed prompt (W15f).
 *
 * Saving a name is not a value-moving action, so these tools run during the turn,
 * need no approval and produce no `Intent`; the loop speaks their `toSpeech`
 * sentence. The agent core never touches the store itself: the shell injects
 * `ToolContext.contacts`, backed by the existing Rust `contacts_*` commands and
 * the StrKey checksum. This module owns the unsafe checks (a secret key or a
 * recovery phrase is refused and never echoed), the normalisation and the
 * deterministic sentence.
 */
import { shortAddress } from "../accountRefs.ts";
import { languageBase } from "../language.ts";
import type { AgentTool, ToolContext } from "./registry.ts";

/** A saved recipient; field names match the Rust store and `contactsModel.ts`. */
export interface Contact {
  nickname: string;
  address: string;
}

/** Result of a save attempt, as the shell's store reports it. */
export type SaveContactResult =
  | { status: "saved"; nickname: string; address: string }
  | { status: "alreadySaved"; nickname: string }
  | { status: "nameTaken"; nickname: string }
  | { status: "invalidName" }
  | { status: "invalidAddress" }
  | { status: "unavailable" };

/** Result of a delete attempt. */
export type RemoveContactResult =
  | { status: "removed"; nickname: string }
  | { status: "missing" }
  | { status: "unavailable" };

/**
 * The address book the tools act on. Implemented in `app/src/lib/contacts.ts`
 * over the Tauri commands; a fake is used in tests. Absent means the tools say
 * they cannot read or write the book rather than guessing.
 */
export interface ContactStore {
  save(nickname: string, address: string): Promise<SaveContactResult>;
  list(): Promise<readonly Contact[]>;
  remove(nickname: string): Promise<RemoveContactResult>;
}

/** A `G...` public key: 56 base32 characters. The checksum is checked by the store. */
const PUBLIC_KEY = /^G[A-Z2-7]{55}$/;

/**
 * A Stellar secret key is `S` followed by 55 base32 characters. Whitespace is
 * removed first, because STT may space the characters out.
 */
const SECRET_KEY = /S[A-Z2-7]{55}/;

/** True when `text` carries something shaped like a Stellar secret key. */
export function containsSecretKey(text: string): boolean {
  return SECRET_KEY.test(text.replace(/\s+/g, ""));
}

/**
 * A rough recovery-phrase test: 12/15/18/21/24 lowercase words and nothing else.
 * Deliberately strict so a normal sentence is not mistaken for a mnemonic; a
 * false refusal is safe, a false accept is not.
 */
export function looksLikeRecoveryPhrase(text: string): boolean {
  const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (![12, 15, 18, 21, 24].includes(words.length)) return false;
  return words.every((word) => /^[a-z]{3,8}$/.test(word));
}

/** The stored nickname form: trimmed and lowercased, as the Rust store keeps it. */
export function normalizeContactName(value: string): string {
  return value.trim().toLowerCase();
}

/** True for a `G...` address of the right shape; the checksum is the store's job. */
export function isStellarAddressShape(value: string): boolean {
  return PUBLIC_KEY.test(value.trim());
}

/** `ada` -> `Ada`, so the spoken reply reads like a name. */
function titleName(name: string): string {
  return name.length === 0 ? name : name.charAt(0).toUpperCase() + name.slice(1);
}

/* ------------------------------------------------------------------ *
 * `save_contact`
 * ------------------------------------------------------------------ */

/** Raw model input. `address` may be missing when the user only named a contact. */
export interface SaveContactInput {
  name?: unknown;
  address?: unknown;
  language?: unknown;
}

/** What `run` returns; `spoken` is the exact sentence the loop will say. */
export interface SaveContactOutput {
  status:
    | SaveContactResult["status"]
    | "secret"
    | "addressNeeded"
    | "nameNeeded";
  /** Present once a name is known (saved, already saved or taken). */
  nickname?: string;
  /** The short display address, present when the save succeeded. */
  address?: string;
  spoken: string;
}

function languageOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function pick(language: string | undefined, en: string, tr: string): string {
  return languageBase(language) === "tr" ? tr : en;
}

function saveSentence(result: SaveContactResult, language: string | undefined): string {
  switch (result.status) {
    case "saved": {
      const short = shortAddress(result.address) ?? result.address;
      return pick(language, `Saved ${titleName(result.nickname)} → ${short}.`, `Kaydedildi: ${titleName(result.nickname)} → ${short}.`);
    }
    case "alreadySaved":
      return pick(
        language,
        `${titleName(result.nickname)} is already saved.`,
        `${titleName(result.nickname)} zaten kayıtlı.`,
      );
    case "nameTaken":
      return pick(
        language,
        `${titleName(result.nickname)} is already saved to a different address. Please pick another name.`,
        `${titleName(result.nickname)} farklı bir adrese kayıtlı. Lütfen başka bir isim seç.`,
      );
    case "invalidName":
      return pick(
        language,
        "That name isn't valid. Use letters, numbers, _ or -.",
        "Bu isim geçerli değil. Harf, rakam, _ veya - kullan.",
      );
    case "invalidAddress":
      return pick(
        language,
        "That isn't a valid Stellar address. Please check it.",
        "Bu geçerli bir Stellar adresi değil. Lütfen kontrol et.",
      );
    case "unavailable":
      return pick(
        language,
        "Saving contacts isn't available right now.",
        "Kişi kaydetme şu an kullanılamıyor.",
      );
  }
}

export const saveContactTool: AgentTool<SaveContactInput, SaveContactOutput> = {
  name: "save_contact",
  description:
    "Save a Stellar G... address under a short name so it can be paid by name later. Read-only: it moves no value and needs no approval.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description:
          'The short name to save, e.g. "Ada". Letters, numbers, _ and - only.',
      },
      address: {
        type: "string",
        description:
          'The full Stellar public key (56 characters, starts with "G"). Omit it when the user did not say the address; the app asks for it.',
      },
      language: {
        type: "string",
        description:
          'The language the user spoke, as a BCP-47 base code ("tr" or "en"). Used to phrase the spoken reply; never spoken itself.',
      },
    },
    required: ["name"],
    additionalProperties: false,
  },
  async run(input: SaveContactInput, ctx: ToolContext): Promise<SaveContactOutput> {
    const language = languageOf(input?.language);
    const rawName = typeof input?.name === "string" ? input.name : "";
    const rawAddress = typeof input?.address === "string" ? input.address.trim() : "";

    // Unsafe material is refused before anything else and never repeated.
    if (
      containsSecretKey(ctx.transcript) ||
      containsSecretKey(rawAddress) ||
      looksLikeRecoveryPhrase(rawAddress)
    ) {
      return {
        status: "secret",
        spoken: pick(
          language,
          "I can't save a secret key or recovery phrase. Use the Wallet screen to import it.",
          "Gizli anahtar veya kurtarma ifadesi kaydedemem. İçe aktarmak için Cüzdan ekranını kullan.",
        ),
      };
    }

    const nickname = normalizeContactName(rawName);
    if (nickname.length === 0) {
      return {
        status: "nameNeeded",
        spoken: pick(language, "What name should I save it as?", "Hangi isimle kaydedeyim?"),
      };
    }
    if (rawAddress.length === 0) {
      return {
        status: "addressNeeded",
        spoken: pick(
          language,
          "Please type the full Stellar address in the prompt.",
          "Lütfen tam Stellar adresini yaz.",
        ),
      };
    }
    if (!isStellarAddressShape(rawAddress)) {
      const result: SaveContactResult = { status: "invalidAddress" };
      return { status: result.status, nickname, spoken: saveSentence(result, language) };
    }
    if (!ctx.contacts) {
      const result: SaveContactResult = { status: "unavailable" };
      return { status: result.status, spoken: saveSentence(result, language) };
    }

    const result = await ctx.contacts.save(nickname, rawAddress);
    return {
      status: result.status,
      ...(result.status === "saved" || result.status === "alreadySaved" || result.status === "nameTaken"
        ? { nickname: result.nickname }
        : {}),
      ...(result.status === "saved" ? { address: result.address } : {}),
      spoken: saveSentence(result, language),
    };
  },
  toSpeech(output: SaveContactOutput): string {
    return output.spoken;
  },
};

/* ------------------------------------------------------------------ *
 * `list_contacts`
 * ------------------------------------------------------------------ */

export interface ListContactsInput {
  language?: unknown;
}

export interface ListContactsOutput {
  contacts: Contact[];
  spoken: string;
}

/** Names are listed shortest-first, capped so the sentence stays short. */
const MAX_SPOKEN_CONTACTS = 5;

function listSentence(contacts: readonly Contact[], language: string | undefined): string {
  if (contacts.length === 0) {
    return pick(language, "You have no saved contacts.", "Kayıtlı kişin yok.");
  }
  const names = contacts.slice(0, MAX_SPOKEN_CONTACTS).map((contact) => contact.nickname);
  const extra = contacts.length - names.length;
  const list = names.join(", ");
  const more = extra > 0 ? pick(language, ` and ${extra} more`, ` ve ${extra} tane daha`) : "";
  return pick(
    language,
    `You have ${contacts.length} saved contact${contacts.length === 1 ? "" : "s"}: ${list}${more}.`,
    `${contacts.length} kayıtlı kişin var: ${list}${more}.`,
  );
}

export const listContactsTool: AgentTool<ListContactsInput, ListContactsOutput> = {
  name: "list_contacts",
  description:
    "List the contact names saved on this device. Read-only; it never moves value.",
  inputSchema: {
    type: "object",
    properties: {
      language: {
        type: "string",
        description:
          'The language the user spoke, as a BCP-47 base code ("tr" or "en"). Used to phrase the spoken answer; never spoken itself.',
      },
    },
    additionalProperties: false,
  },
  async run(input: ListContactsInput, ctx: ToolContext): Promise<ListContactsOutput> {
    const language = languageOf(input?.language);
    if (!ctx.contacts) {
      return {
        contacts: [],
        spoken: pick(language, "I can't read your contacts right now.", "Kişilerini şu an okuyamıyorum."),
      };
    }
    try {
      const contacts = [...(await ctx.contacts.list())];
      return { contacts, spoken: listSentence(contacts, language) };
    } catch {
      return {
        contacts: [],
        spoken: pick(language, "I can't read your contacts right now.", "Kişilerini şu an okuyamıyorum."),
      };
    }
  },
  toSpeech(output: ListContactsOutput): string {
    return output.spoken;
  },
};

/* ------------------------------------------------------------------ *
 * `delete_contact`
 * ------------------------------------------------------------------ */

export interface DeleteContactInput {
  name?: unknown;
  language?: unknown;
}

export interface DeleteContactOutput {
  status: RemoveContactResult["status"] | "nameNeeded";
  spoken: string;
}

function removeSentence(result: RemoveContactResult, name: string, language: string | undefined): string {
  switch (result.status) {
    case "removed":
      return pick(language, `Removed ${titleName(result.nickname)}.`, `${titleName(result.nickname)} silindi.`);
    case "missing":
      return pick(
        language,
        `I don't have a contact named ${titleName(name)}.`,
        `${titleName(name)} adlı bir kişin yok.`,
      );
    case "unavailable":
      return pick(
        language,
        "Removing contacts isn't available right now.",
        "Kişi silme şu an kullanılamıyor.",
      );
  }
}

export const deleteContactTool: AgentTool<DeleteContactInput, DeleteContactOutput> = {
  name: "delete_contact",
  description:
    "Forget a saved contact name. Read-only: it moves no value and needs no approval.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "The saved name to forget, e.g. \"Ada\"." },
      language: {
        type: "string",
        description:
          'The language the user spoke, as a BCP-47 base code ("tr" or "en"). Used to phrase the spoken reply; never spoken itself.',
      },
    },
    required: ["name"],
    additionalProperties: false,
  },
  async run(input: DeleteContactInput, ctx: ToolContext): Promise<DeleteContactOutput> {
    const language = languageOf(input?.language);
    const nickname = normalizeContactName(typeof input?.name === "string" ? input.name : "");
    if (nickname.length === 0) {
      return {
        status: "nameNeeded",
        spoken: pick(language, "Which contact should I remove?", "Hangi kişiyi sileyim?"),
      };
    }
    if (!ctx.contacts) {
      const result: RemoveContactResult = { status: "unavailable" };
      return { status: result.status, spoken: removeSentence(result, nickname, language) };
    }
    const result = await ctx.contacts.remove(nickname);
    return { status: result.status, spoken: removeSentence(result, nickname, language) };
  },
  toSpeech(output: DeleteContactOutput): string {
    return output.spoken;
  },
};
