/**
 * Settings page body — session, status, privacy, diagnostics and quit (task W15d).
 *
 * One calm scrolling column: section titles with hairline dividers, no cards and
 * no nested surfaces. Everything here is read-only except three actions: change
 * the auto-lock timeout, log out, and quit. Value movement stays in the shared
 * wallet pipeline, which this page never touches.
 */
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  AUTO_LOCK_OPTIONS,
  DEFAULT_AUTO_LOCK_MINUTES,
} from "@/lib/walletSession";
import { quitPolaris } from "@/lib/app";
import {
  loadSppStatus,
  summarizeSppStatus,
  type SppStatusSummary,
} from "@/lib/spp";
import { cn } from "@/lib/utils";
import {
  useWalletSession,
  useWalletSessionActions,
} from "@/notch/wallet/useWalletSession";

import { DiagnosticsSection } from "./DiagnosticsSection";
import { buildStatusRows, type StatusLevel } from "./statusModel";
import { useSettingsData } from "./useSettingsData";
import { DOT, FIELD, HINT, SECTION_TITLE } from "./ui";

const DOT_STYLES: Record<StatusLevel, string> = {
  ok: "bg-polaris-ok",
  warn: "bg-polaris-warn",
  fail: "bg-polaris-danger",
  unknown: "bg-polaris-muted",
};

/** Spoken word for the dot, so the state never depends on colour alone. */
const LEVEL_LABEL: Record<StatusLevel, string> = {
  ok: "OK",
  warn: "Warning",
  fail: "Failing",
  unknown: "Unknown",
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className={SECTION_TITLE}>{title}</h2>
      <div className="h-px bg-white/10" />
      {children}
    </section>
  );
}

function SessionSection() {
  const { session, available } = useWalletSession();
  const { setAutoLock, lock } = useWalletSessionActions();
  const unlocked = session?.state === "unlocked";

  if (available === false) {
    return (
      <Section title="Session">
        <p className={HINT}>The wallet session is not available in this build.</p>
      </Section>
    );
  }

  return (
    <Section title="Session">
      <div className="flex items-center justify-between gap-3">
        <label className={HINT} htmlFor="settings-auto-lock">
          Auto-lock
        </label>
        <select
          id="settings-auto-lock"
          className={FIELD}
          value={session?.autoLockMinutes ?? DEFAULT_AUTO_LOCK_MINUTES}
          disabled={available === null}
          onChange={(event) => void setAutoLock(Number(event.target.value))}
        >
          {AUTO_LOCK_OPTIONS.map((option) => (
            <option key={option.minutes} value={option.minutes}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-center justify-between gap-3">
        <p className={HINT}>
          {unlocked
            ? `Logged in${session?.active ? ` as ${session.active.label}` : ""}`
            : "Logged out"}
        </p>
        <Button variant="outline" size="sm" disabled={!unlocked} onClick={() => void lock()}>
          Log out
        </Button>
      </div>
    </Section>
  );
}

function StatusSection() {
  const { voice, chain, touchId, horizonReachable, version, loading, failed, refresh } =
    useSettingsData();
  const rows = buildStatusRows({
    voice,
    chain,
    touchId: touchId ? { status: touchId.status, detail: touchId.detail } : null,
    horizonReachable,
  });

  return (
    <Section title="Status">
      {loading ? (
        <p className={HINT}>Checking…</p>
      ) : failed ? (
        <p className={HINT}>
          Could not read the app&apos;s health.{" "}
          <button type="button" className="underline" onClick={refresh}>
            Retry
          </button>
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => (
            <li key={row.id} className="flex items-start gap-2">
              <span className={cn(DOT, DOT_STYLES[row.level])} aria-hidden="true" />
              <div className="min-w-0">
                <p className="text-xs font-medium">
                  {row.label}
                  <span className="sr-only"> — {LEVEL_LABEL[row.level]}</span>
                </p>
                <p className={cn(HINT, "break-words")}>{row.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
      {version ? <p className={HINT}>Version {version}</p> : null}
    </Section>
  );
}

function PrivacySection() {
  const [spp, setSpp] = useState<SppStatusSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadSppStatus().then((facts) => {
      if (!cancelled) setSpp(summarizeSppStatus(facts));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Section title="Privacy">
      <ul className="list-disc space-y-1 pl-4 text-[11px] leading-4 text-polaris-muted">
        <li>Wallet keys stay in the macOS Keychain; this window can never read them.</li>
        <li>
          Only the calls you configure leave this Mac: speech, the agent, and the
          Stellar network.
        </li>
        <li>No key or recovery phrase is ever sent to the agent, the webview or the repository.</li>
      </ul>
      <p className={HINT}>
        Private payments (testnet): {spp?.detail ?? "checking the testnet RPC…"}
      </p>
    </Section>
  );
}

function QuitSection() {
  const [confirming, setConfirming] = useState(false);

  return (
    <Section title="Quit Polaris">
      {confirming ? (
        <div className="flex items-center gap-3">
          <Button variant="danger" size="sm" onClick={() => void quitPolaris()}>
            Quit now
          </Button>
          <button type="button" className={cn(HINT, "underline")} onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
          Quit Polaris
        </Button>
      )}
    </Section>
  );
}

export function SettingsView() {
  return (
    <div className="page-stack">
      <SessionSection />
      <StatusSection />
      <PrivacySection />
      <Section title="Diagnostics">
        <DiagnosticsSection />
      </Section>
      <QuitSection />
    </div>
  );
}
