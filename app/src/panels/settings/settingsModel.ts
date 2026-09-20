/**
 * Pure view model for the Settings panel (T1).
 *
 * Flattens the read-only diagnostics the shell already exposes — `voice_health`
 * and `stellar_config` — into sections of setting rows, each with
 * a value, a status badge and the `.env` variable that changes it. It imports no
 * React and no Tauri, so the mapping is unit-tested with `node:test`.
 *
 * Nothing here sees a secret: the voice facts are presence booleans and the only
 * values echoed are public (network, addresses, contract ids, model ids).
 */

/** Same vocabulary as the Debug contract, so the badges stay consistent. */
export type SettingStatus = "ok" | "warn" | "fail" | "unknown";

export interface SettingRow {
  id: string;
  label: string;
  value: string;
  status: SettingStatus;
  /** The `.env` variable that changes this row, or "" when it has none. */
  envVar: string;
}

export interface SettingSection {
  id: string;
  title: string;
  rows: SettingRow[];
}

/**
 * The non-secret voice facts. `sttLanguage`, `sttAllowedLanguages` and
 * `ttsVoice` are the three values `voice_health` does **not** report yet; their
 * rows stay `unknown` until that command is extended by the milestone that owns
 * it. Filling them in here needs no change on this side.
 */
export interface VoiceFacts {
  sttBackend: "groq" | "ondevice";
  ttsBackend: "fish" | "local";
  agentProvider: "openai" | "anthropic";
  groqKey: boolean;
  fishKey: boolean;
  anthropicKey: boolean;
  openaiCompatKey: boolean;
  sttLanguage?: string | null;
  sttAllowedLanguages?: string | null;
  ttsVoice?: string | null;
}

/** The non-secret chain facts; `null` means the command did not answer. */
export interface ChainFacts {
  network: string;
  ownerAddress: string | null;
  guardContractId: string | null;
  p2pContractId: string | null;
}

export interface SettingsInput {
  version: string | null;
  voice: VoiceFacts | null;
  chain: ChainFacts | null;
  agentModel: string;
}

/** Shortens a 56-char address/contract id to `head…tail` for the compact rows. */
export function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

/**
 * A reported value, or an `unknown` row when the source cannot report it. An
 * empty string is a real answer (unset -> the documented default), not unknown.
 */
function reported(
  value: string | null | undefined,
  unsetLabel: string,
): { value: string; status: SettingStatus } {
  if (value === undefined) {
    return { value: "not reported by this build", status: "unknown" };
  }
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0
    ? { value: trimmed, status: "ok" }
    : { value: unsetLabel, status: "ok" };
}

function sttBackend(voice: VoiceFacts | null): { value: string; status: SettingStatus } {
  if (!voice) return { value: "not reported by this build", status: "unknown" };
  if (voice.sttBackend === "groq") {
    return voice.groqKey
      ? { value: "groq (cloud, auto language detect)", status: "ok" }
      : { value: "groq (missing GROQ_API_KEY)", status: "fail" };
  }
  return { value: "ondevice (private, single locale)", status: "warn" };
}

function ttsBackend(voice: VoiceFacts | null): { value: string; status: SettingStatus } {
  if (!voice) return { value: "not reported by this build", status: "unknown" };
  if (voice.ttsBackend === "local") return { value: "local macOS speech", status: "ok" };
  return voice.fishKey
    ? { value: "Fish Audio", status: "ok" }
    : { value: "Fish Audio (no key; local fallback)", status: "warn" };
}

function agentProvider(voice: VoiceFacts | null): { value: string; status: SettingStatus } {
  if (!voice) return { value: "not reported by this build", status: "unknown" };
  if (voice.agentProvider === "anthropic") {
    return voice.anthropicKey
      ? { value: "anthropic", status: "ok" }
      : { value: "anthropic (missing ANTHROPIC_API_KEY)", status: "fail" };
  }
  return voice.openaiCompatKey
    ? { value: "openai-compatible", status: "ok" }
    : { value: "openai-compatible (missing OPENCODE_API_KEY)", status: "fail" };
}

function keyRow(
  id: string,
  label: string,
  present: boolean | undefined,
  envVar: string,
): SettingRow {
  if (present === undefined) {
    return { id, label, value: "not reported by this build", status: "unknown", envVar };
  }
  return present
    ? { id, label, value: "present", status: "ok", envVar }
    : { id, label, value: "not set", status: "warn", envVar };
}

function networkRow(chain: ChainFacts | null): SettingRow {
  const envVar = "STELLAR_NETWORK";
  if (!chain) {
    return { id: "stellar.network", label: "Network", value: "not reported by this build", status: "unknown", envVar };
  }
  return chain.network === "testnet"
    ? { id: "stellar.network", label: "Network", value: "testnet", status: "ok", envVar }
    : { id: "stellar.network", label: "Network", value: `${chain.network} (testnet only!)`, status: "fail", envVar };
}

function idRow(
  id: string,
  label: string,
  chain: ChainFacts | null,
  value: string | null | undefined,
  envVar: string,
): SettingRow {
  if (!chain) {
    return { id, label, value: "not reported by this build", status: "unknown", envVar };
  }
  return value
    ? { id, label, value: shortId(value), status: "ok", envVar }
    : { id, label, value: "not set", status: "warn", envVar };
}

/** Builds every section the panel renders, in display order. */
export function buildSettingsView(input: SettingsInput): SettingSection[] {
  const { voice, chain } = input;

  return [
    {
      id: "app",
      title: "App",
      rows: [
        {
          id: "app.version",
          label: "Version",
          value: input.version ?? "unknown",
          status: input.version ? "ok" : "unknown",
          envVar: "",
        },
      ],
    },
    {
      id: "stt",
      title: "Speech to text",
      rows: [
        { id: "stt.backend", label: "Backend", ...sttBackend(voice), envVar: "POLARIS_STT_BACKEND" },
        {
          id: "stt.language",
          label: "Language",
          ...reported(voice?.sttLanguage, "auto-detect (default)"),
          envVar: "POLARIS_STT_LANGUAGE",
        },
        {
          id: "stt.allowed",
          label: "Allowed languages",
          ...reported(voice?.sttAllowedLanguages, "tr,en (default)"),
          envVar: "POLARIS_STT_ALLOWED_LANGS",
        },
      ],
    },
    {
      id: "tts",
      title: "Text to speech",
      rows: [
        { id: "tts.backend", label: "Backend", ...ttsBackend(voice), envVar: "POLARIS_TTS_BACKEND" },
        {
          id: "tts.voice",
          label: "Voice",
          ...reported(voice?.ttsVoice, "pinned default"),
          envVar: "POLARIS_TTS_REFERENCE_ID",
        },
      ],
    },
    {
      id: "agent",
      title: "Agent",
      rows: [
        {
          id: "agent.provider",
          label: "Provider",
          ...agentProvider(voice),
          envVar: "POLARIS_AGENT_PROVIDER",
        },
        {
          id: "agent.model",
          label: "Model",
          value: input.agentModel || "unknown",
          status: input.agentModel ? "ok" : "unknown",
          envVar: "POLARIS_AGENT_MODEL",
        },
      ],
    },
    {
      id: "credentials",
      title: "Credentials (presence only)",
      rows: [
        keyRow("credentials.groq", "GROQ_API_KEY", voice?.groqKey, "GROQ_API_KEY"),
        keyRow("credentials.fish", "FISH_AUDIO_API_KEY", voice?.fishKey, "FISH_AUDIO_API_KEY"),
        keyRow("credentials.anthropic", "ANTHROPIC_API_KEY", voice?.anthropicKey, "ANTHROPIC_API_KEY"),
        keyRow("credentials.opencode", "OPENCODE_API_KEY", voice?.openaiCompatKey, "OPENCODE_API_KEY"),
      ],
    },
    {
      id: "stellar",
      title: "Stellar (testnet only)",
      rows: [
        networkRow(chain),
        idRow("stellar.owner", "Owner address", chain, chain?.ownerAddress, "POLARIS_OWNER_ADDRESS"),
        idRow("stellar.guard", "Guard contract", chain, chain?.guardContractId, "GUARD_CONTRACT_ID"),
        idRow("stellar.p2p", "P2P contract", chain, chain?.p2pContractId, "POLARIS_P2P_CONTRACT_ID"),
      ],
    },
  ];
}
