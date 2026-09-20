/**
 * Pure view model for the Settings page's Status section (task W15d).
 *
 * Maps the non-secret health facts the shell already exposes — `voice_health`,
 * `stellar_config` and `biometric_health` — onto four one-line rows, each with a
 * severity. It imports no React and no Tauri, so the mapping is unit-tested
 * under `node:test`. Nothing here sees a secret: the voice facts are presence
 * booleans and the only values echoed (network, contract ids) are public.
 */
import type { VoiceHealth } from "@/debug/commands";

/** Same vocabulary as the Debug contract, so the dots stay consistent. */
export type StatusLevel = "ok" | "warn" | "fail" | "unknown";

export interface StatusRow {
  id: string;
  label: string;
  detail: string;
  level: StatusLevel;
}

/**
 * The chain facts the Status rows need. `StellarConfig` is structurally
 * assignable to this, which keeps the pure tests free of unrelated fields.
 */
export interface ChainFacts {
  network: string;
  horizonUrl?: string | null;
  guardContractId?: string | null;
  p2pContractId?: string | null;
}

/** The Touch ID facts, taken verbatim from `biometric_health`. */
export interface TouchIdFacts {
  status: StatusLevel;
  detail: string;
}

export interface StatusInput {
  voice: VoiceHealth | null;
  chain: ChainFacts | null;
  touchId: TouchIdFacts | null;
  /** `null`/`undefined` while the probe has not answered yet. */
  horizonReachable?: boolean | null;
}

const RANK: Record<StatusLevel, number> = { unknown: 0, ok: 1, warn: 2, fail: 3 };

function worst(levels: readonly StatusLevel[]): StatusLevel {
  return levels.reduce<StatusLevel>(
    (acc, level) => (RANK[level] > RANK[acc] ? level : acc),
    "unknown",
  );
}

/** Shortens a 56-char contract id to `head…tail` for the compact rows. */
export function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

/** The `host` of a URL, or the raw string when it does not parse. */
export function horizonHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function voiceRow(voice: VoiceHealth | null): StatusRow {
  if (voice === null) {
    return { id: "voice", label: "Voice", detail: "not reported by this build", level: "unknown" };
  }
  const parts: string[] = [];
  const levels: StatusLevel[] = [];

  if (voice.sttBackend === "groq") {
    parts.push(voice.groqKey ? "STT Groq" : "STT Groq — add GROQ_API_KEY");
    levels.push(voice.groqKey ? "ok" : "fail");
  } else {
    parts.push("STT on-device");
    levels.push("warn");
  }

  if (voice.ttsBackend === "local") {
    parts.push("TTS local");
    levels.push("ok");
  } else if (voice.fishKey) {
    parts.push("TTS Fish Audio");
    levels.push("ok");
  } else {
    parts.push("TTS Fish Audio — local fallback");
    levels.push("warn");
  }

  const provider = voice.agentProvider === "anthropic" ? "Anthropic" : "OpenAI";
  const keyPresent =
    voice.agentProvider === "anthropic" ? voice.anthropicKey : voice.openaiCompatKey;
  parts.push(keyPresent ? `agent ${provider}` : `agent ${provider} — add key`);
  levels.push(keyPresent ? "ok" : "fail");

  return { id: "voice", label: "Voice", detail: parts.join(" · "), level: worst(levels) };
}

function networkRow(chain: ChainFacts | null, horizonReachable?: boolean | null): StatusRow {
  if (chain === null) {
    return { id: "network", label: "Network", detail: "not reported by this build", level: "unknown" };
  }
  if (chain.network !== "testnet") {
    return { id: "network", label: "Network", detail: `${chain.network} — testnet only`, level: "fail" };
  }
  if (!chain.horizonUrl) {
    return { id: "network", label: "Network", detail: "testnet · no Horizon URL", level: "warn" };
  }
  if (horizonReachable === false) {
    return { id: "network", label: "Network", detail: "testnet · Horizon unreachable", level: "fail" };
  }
  return {
    id: "network",
    label: "Network",
    detail:
      horizonReachable === true
        ? "testnet · Horizon reachable"
        : `testnet · Horizon ${horizonHost(chain.horizonUrl)}`,
    level: "ok",
  };
}

function contractsRow(chain: ChainFacts | null): StatusRow {
  if (chain === null) {
    return {
      id: "contracts",
      label: "Contracts",
      detail: "not reported by this build",
      level: "unknown",
    };
  }
  const guard = chain.guardContractId ? shortId(chain.guardContractId) : null;
  const escrow = chain.p2pContractId ? shortId(chain.p2pContractId) : null;
  return {
    id: "contracts",
    label: "Contracts",
    detail: `guard ${guard ?? "not set"} · escrow ${escrow ?? "not set"}`,
    level: guard && escrow ? "ok" : "warn",
  };
}

function touchIdRow(touchId: TouchIdFacts | null): StatusRow {
  if (touchId === null) {
    return {
      id: "touchId",
      label: "Touch ID",
      detail: "not reported by this build",
      level: "unknown",
    };
  }
  return { id: "touchId", label: "Touch ID", detail: touchId.detail, level: touchId.status };
}

/** Builds the four Status rows, in display order. */
export function buildStatusRows(input: StatusInput): StatusRow[] {
  return [
    voiceRow(input.voice),
    networkRow(input.chain, input.horizonReachable),
    contractsRow(input.chain),
    touchIdRow(input.touchId),
  ];
}
