/**
 * Reads the non-secret facts the Settings page shows (task W15d).
 *
 * `voice_health`, `stellar_config`, `biometric_health` and `app_info` are read
 * once on mount and on demand; a missing command degrades to `null` rather than
 * breaking the page. No secret is ever read: the voice payload is presence
 * booleans and the chain payload is an allow-list of public ids.
 */
import { useCallback, useEffect, useState } from "react";

import {
  getBiometricHealthIfAvailable,
  getVoiceHealth,
  type DebugFeatureHealth,
  type VoiceHealth,
} from "@/debug/commands";
import { getAppInfo } from "@/lib/polaris";
import { getStellarConfig } from "@/lib/stellarConfig";
import type { StellarConfig } from "@polaris/interfaces";

export interface SettingsData {
  voice: VoiceHealth | null;
  chain: StellarConfig | null;
  touchId: DebugFeatureHealth | null;
  /** `null` until the Horizon probe answers. */
  horizonReachable: boolean | null;
  version: string | null;
  loading: boolean;
  /** True when neither health source answered, so nothing can be shown. */
  failed: boolean;
  refresh: () => void;
}

interface Facts {
  voice: VoiceHealth | null;
  chain: StellarConfig | null;
  touchId: DebugFeatureHealth | null;
  horizonReachable: boolean | null;
  version: string | null;
  loading: boolean;
  failed: boolean;
}

const INITIAL: Facts = {
  voice: null,
  chain: null,
  touchId: null,
  horizonReachable: null,
  version: null,
  loading: true,
  failed: false,
};

/** A short reachability probe; a timeout or any failure reads as unreachable. */
async function probeHorizon(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4_000);
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function useSettingsData(): SettingsData {
  const [facts, setFacts] = useState<Facts>(INITIAL);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const warn = (label: string) => (error: unknown) =>
      console.warn(`settings could not read ${label}`, error);

    void (async () => {
      const [voice, chain, touchId, version] = await Promise.all([
        getVoiceHealth().catch((error: unknown) => {
          warn("voice_health")(error);
          return null;
        }),
        getStellarConfig().catch((error: unknown) => {
          warn("stellar_config")(error);
          return null;
        }),
        getBiometricHealthIfAvailable(),
        getAppInfo()
          .then((info) => info.version)
          .catch((error: unknown) => {
            warn("app_info")(error);
            return null;
          }),
      ]);
      if (cancelled) return;
      setFacts({
        voice,
        chain,
        touchId,
        horizonReachable: null,
        version,
        loading: false,
        failed: voice === null && chain === null && touchId === null,
      });

      if (chain?.horizonUrl) {
        const reachable = await probeHorizon(chain.horizonUrl);
        if (!cancelled) setFacts((previous) => ({ ...previous, horizonReachable: reachable }));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [nonce]);

  const refresh = useCallback(() => {
    setFacts((previous) => ({ ...previous, loading: true, failed: false }));
    setNonce((value) => value + 1);
  }, []);

  return { ...facts, refresh };
}
