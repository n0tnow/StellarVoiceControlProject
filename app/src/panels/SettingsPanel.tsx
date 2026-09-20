import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { getBridgeHealth, getVoiceHealth } from "@/debug/commands";
import { redact } from "@/debug/redact";
import { AGENT_MODEL, AGENT_PROVIDER } from "@/lib/agent";
import { getAppInfo } from "@/lib/polaris";
import { loadPreferences, saveApprovalThresholdUsd } from "@/lib/preferences";
import { getStellarConfig } from "@/lib/stellarConfig";
import { PanelNote, PanelShell } from "@/panels/PanelShell";
import {
  buildSettingsView,
  type SettingsInput,
  type VoiceFacts,
} from "@/panels/settings/settingsModel";
import { StatusBadge } from "@/panels/settings/StatusBadge";

/**
 * Settings panel (T1).
 *
 * A read-only status board for the voice stack and the chain config. It reads
 * `voice_health` and `stellar_config` (plus `app_info` and the bundled agent
 * model) and renders one row per setting with a status badge and the `.env`
 * variable that changes it. Secrets appear only as present/not set: the window
 * never receives a key value and has no editor for one.
 */
export function SettingsPanel() {
  const [version, setVersion] = useState<string | null>(null);
  const [voice, setVoice] = useState<VoiceFacts | null>(null);
  const [chain, setChain] = useState<SettingsInput["chain"]>(null);
  const [bridge, setBridge] = useState<SettingsInput["bridge"]>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  // The one writable preference. The draft is what the input shows; the stored
  // value is what `approvalThresholdUsd` reports until a valid draft is saved.
  const [threshold, setThreshold] = useState(() => loadPreferences().approvalThresholdUsd);
  const [thresholdDraft, setThresholdDraft] = useState(() =>
    String(loadPreferences().approvalThresholdUsd),
  );
  const [thresholdHint, setThresholdHint] = useState<string | null>(null);

  const saveThreshold = useCallback(() => {
    const parsed = Number(thresholdDraft.trim());
    if (!Number.isFinite(parsed) || parsed < 0) {
      setThresholdHint("Enter a non-negative number of USD (0 = always ask).");
      return;
    }
    saveApprovalThresholdUsd(parsed);
    const stored = loadPreferences().approvalThresholdUsd;
    setThreshold(stored);
    setThresholdDraft(String(stored));
    setThresholdHint(
      stored === 0
        ? "Saved. Every payment asks (D10 default)."
        : `Saved. USD payments below $${stored} skip the card.`,
    );
  }, [thresholdDraft]);

  useEffect(() => {
    let cancelled = false;
    const warn = (label: string) => (error: unknown) =>
      console.warn(`settings could not read ${label}`, error);
    void getAppInfo()
      .then((info) => {
        if (!cancelled) setVersion(info.version);
      })
      .catch(warn("app_info"));
    void getVoiceHealth()
      .then((next) => {
        if (!cancelled) setVoice(next);
      })
      .catch(warn("voice_health"));
    void getStellarConfig()
      .then((next) => {
        if (!cancelled) setChain(next);
      })
      .catch(warn("stellar_config"));
    void getBridgeHealth()
      .then((next) => {
        if (!cancelled) setBridge({ status: next.status, detail: next.detail });
      })
      .catch(warn("bridge_health"));
    return () => {
      cancelled = true;
    };
  }, []);

  const view = useMemo(
    () => buildSettingsView({ version, voice, chain, agentModel: AGENT_MODEL, bridge }),
    [version, voice, chain, bridge],
  );

  const copyDiagnostics = useCallback(async () => {
    const report = {
      generatedAt: new Date().toISOString(),
      app: { version },
      agent: { provider: AGENT_PROVIDER, model: AGENT_MODEL },
      chain,
      settings: view.flatMap((section) =>
        section.rows.map((row) => ({ id: row.id, status: row.status, value: row.value })),
      ),
    };
    try {
      await navigator.clipboard.writeText(redact(JSON.stringify(report, null, 2)));
      setCopyState("copied");
    } catch (error: unknown) {
      console.warn("settings could not copy diagnostics", error);
      setCopyState("failed");
    }
  }, [version, chain, view]);

  return (
    <PanelShell title="Settings" subtitle="Read-only configuration and diagnostics">
      <div className="space-y-4">
        <PanelNote>
          Read-only except the approval threshold below. Secrets appear only as
          “present” or “not set”; this window never shows or edits a key.
        </PanelNote>

        <section
          aria-labelledby="approval-threshold-heading"
          className="space-y-2 rounded-lg border border-polaris-line bg-polaris-panel/40 p-3"
        >
          <h2
            id="approval-threshold-heading"
            className="text-xs font-semibold uppercase tracking-wide text-polaris-muted"
          >
            Approval threshold
          </h2>
          <p className="text-xs text-polaris-muted">
            USD-stablecoin payments <span className="font-medium">strictly below</span> this
            amount skip the Touch ID card. <span className="font-medium">0 = always ask</span>{" "}
            (default, D10). A payment the chain flags as “Approval card required: yes” always
            asks, and non-USD assets (e.g. XLM) always ask — there is no price oracle.
          </p>
          <div className="flex items-center gap-2">
            <label htmlFor="approval-threshold-usd" className="text-xs text-polaris-muted">
              Auto-approve below (USD)
            </label>
            <input
              id="approval-threshold-usd"
              type="number"
              min={0}
              step="any"
              inputMode="decimal"
              className="w-28 rounded-md border border-polaris-line bg-polaris-panel px-2 py-1 font-mono text-xs"
              value={thresholdDraft}
              onChange={(event) => {
                setThresholdDraft(event.target.value);
                setThresholdHint(null);
              }}
              aria-describedby="approval-threshold-hint"
            />
            <Button variant="outline" size="sm" onClick={saveThreshold}>
              Save
            </Button>
          </div>
          <p id="approval-threshold-hint" className="text-[10px] text-polaris-muted" aria-live="polite">
            {thresholdHint ?? `Current: ${threshold === 0 ? "always ask" : `$${threshold}`}`}
          </p>
        </section>

        <div className="flex items-center justify-end gap-2">
          {copyState === "copied" ? <span className="text-xs text-polaris-ok">Copied</span> : null}
          {copyState === "failed" ? (
            <span className="text-xs text-polaris-danger">Copy failed</span>
          ) : null}
          <Button variant="outline" size="sm" onClick={() => void copyDiagnostics()}>
            Copy diagnostics
          </Button>
        </div>

        {view.map((section) => (
          <section
            key={section.id}
            className="space-y-2 rounded-lg border border-polaris-line bg-polaris-panel/40 p-3"
          >
            <h2 className="text-xs font-semibold uppercase tracking-wide text-polaris-muted">
              {section.title}
            </h2>
            <ul className="space-y-2">
              {section.rows.map((row) => (
                <li
                  key={row.id}
                  className="space-y-0.5 border-b border-polaris-line/50 pb-2 last:border-0 last:pb-0"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs text-polaris-muted">{row.label}</span>
                    <StatusBadge status={row.status} />
                  </div>
                  <p className="selectable break-words font-mono text-xs">{row.value}</p>
                  {row.envVar ? (
                    <p className="text-[10px] text-polaris-muted">
                      Change in .env: <code className="selectable">{row.envVar}</code>
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </PanelShell>
  );
}
