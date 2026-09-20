import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { getVoiceHealth } from "@/debug/commands";
import { redact } from "@/debug/redact";
import { AGENT_MODEL, AGENT_PROVIDER } from "@/lib/agent";
import { getAppInfo } from "@/lib/polaris";
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
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

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
    return () => {
      cancelled = true;
    };
  }, []);

  const view = useMemo(
    () => buildSettingsView({ version, voice, chain, agentModel: AGENT_MODEL }),
    [version, voice, chain],
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
          Read-only. Secrets appear only as “present” or “not set”; this window
          never shows or edits a key.
        </PanelNote>

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
