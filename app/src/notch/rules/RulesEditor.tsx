/**
 * The notch Rules page: the live spending rule, then one plain-language control.
 *
 * The list row reads the live on-chain rule in plain English with a status dot.
 * The single "Ask me only above" field plus Save creates or updates that rule
 * through the existing auto-pay flow (`guard_policy` intent → batch approval
 * card → ONE Touch ID), so the executor key is set up automatically and the page
 * never builds or signs a transaction itself. `Advanced` reveals the per-payment
 * and per-day limits, the recipient policy and the current on-chain read-back;
 * "Turn off automatic payments" is the existing disable path.
 *
 * Locked/loading/error states are rendered here; the wallet gate lives in
 * `RulesPage`. No mock rule is ever shown for a configured owner, and the global
 * "no popups" rule is respected — everything stays inside the panel.
 */
import { useState } from "react";
import { ChevronDown, CircleAlert, LoaderCircle, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ExplorerLink } from "@/notch/ExplorerLink";

import { ruleSummary, rulesView } from "./rulesModel";
import { useRulesEditor } from "./useRulesEditor";

/** A small labelled decimal input that keeps the notch's look. */
function LimitField({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <label className="task-new">
      <span className="rule-condition">{label}</span>
      <input
        className="task-new-input"
        inputMode="decimal"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function RulesSkeleton() {
  return (
    <ul className="page-list nr-skeleton-list" aria-hidden="true">
      {Array.from({ length: 2 }, (_, index) => (
        <li key={index} className="nr-skeleton" />
      ))}
    </ul>
  );
}

export function RulesEditor() {
  const editor = useRulesEditor();
  const {
    state,
    detail,
    security,
    form,
    patch,
    contacts,
    executorFunded,
    autoPaySupported,
    busy,
    refreshing,
    refreshError,
    message,
    resultHash,
  } = editor;
  const [advanced, setAdvanced] = useState(false);

  const symbol = security?.assetSymbol ?? "XLM";
  const rule = security?.rule ?? null;
  const armed = security !== null && security.executor !== null && (rule?.auto_approve_limit ?? 0n) > 0n;
  const disabled = busy || security === null;
  const lines = security ? rulesView(security, contacts, executorFunded) : [];

  const subtitle =
    state === "loading"
      ? "Reading the chain…"
      : state === "error"
        ? "Could not read the rules"
        : state === "unconfigured"
          ? "Not configured"
          : security?.rule
            ? armed
              ? "Automatic spending is on"
              : "Every payment asks first"
            : "No rule yet";

  return (
    <>
      <header className="nr-head">
        <div className="nr-head-main">
          <h2 className="nr-title">Spending rules</h2>
          <p className="nr-sub">{subtitle}</p>
        </div>
        <button
          type="button"
          className="page-icon-button"
          aria-label="Refresh rules"
          title="Refresh"
          disabled={state === "loading" || busy || refreshing}
          onClick={editor.refresh}
        >
          <RefreshCw className={refreshing ? "page-status is-pending" : undefined} aria-hidden="true" />
        </button>
      </header>

      {refreshError !== null ? (
        <p className="nr-notice is-hint" title={refreshError}>
          <CircleAlert aria-hidden="true" />
          Couldn&apos;t refresh.{" "}
          <button type="button" className="page-icon-button" aria-label="Retry refresh" onClick={editor.refresh}>
            <RefreshCw aria-hidden="true" />
          </button>
        </p>
      ) : null}

      {state === "loading" ? (
        <RulesSkeleton />
      ) : security !== null ? (
        <>
          {!autoPaySupported ? (
            <p className="nr-notice">
              Automatic payments aren&apos;t enabled in this build yet — save is disabled.
            </p>
          ) : null}

          <ul className="page-list">
            <li className="rule-card">
              <div className="rule-head">
                <span className="rule-name">Automatic payments</span>
                <span className={`nr-pill ${armed ? "is-on" : "is-off"}`}>
                  {armed ? "On" : "Always ask"}
                </span>
              </div>
              <p className="rule-body">
                <span className="rule-condition">{ruleSummary(security, symbol)}</span>
              </p>
            </li>
          </ul>

          <div className="rule-card">
            <label className="task-new">
              <span className="rule-condition">Ask me only above</span>
              <input
                className="task-new-input"
                inputMode="decimal"
                value={form.threshold}
                disabled={disabled}
                onChange={(event) => patch({ threshold: event.target.value })}
              />
              <span className="rule-condition">{symbol}</span>
            </label>

            {advanced ? (
              <>
                <LimitField
                  label={`Per payment (${symbol})`}
                  value={form.perTx}
                  disabled={disabled}
                  onChange={(perTx) => patch({ perTx })}
                />
                <LimitField
                  label={`Per day (${symbol})`}
                  value={form.daily}
                  disabled={disabled}
                  onChange={(daily) => patch({ daily })}
                />
                <div className="rule-head">
                  <span className="rule-condition">Saved contacts only</span>
                  <button
                    type="button"
                    className={`page-toggle${form.knownRecipientsOnly ? " is-on" : ""}`}
                    aria-pressed={form.knownRecipientsOnly}
                    aria-label="Saved contacts only"
                    disabled={disabled}
                    onClick={() => patch({ knownRecipientsOnly: !form.knownRecipientsOnly })}
                  >
                    <span className="page-toggle-knob" />
                  </button>
                </div>
                <p className="rule-condition">Asset: {symbol} (native; one asset per rule)</p>
              </>
            ) : null}

            <div className="rule-approval">
              <Button size="sm" disabled={disabled} onClick={() => void editor.save()}>
                {busy ? "Saving…" : "Save"}
              </Button>
            </div>

            <button
              type="button"
              className={`rule-disclosure${advanced ? " is-open" : ""}`}
              aria-expanded={advanced}
              onClick={() => setAdvanced((value) => !value)}
            >
              <ChevronDown aria-hidden="true" />
              {advanced ? "Hide advanced" : "Advanced"}
            </button>

            {armed ? (
              <button
                type="button"
                className="rule-danger"
                disabled={disabled}
                onClick={() => void editor.disable()}
              >
                Turn off automatic payments
              </button>
            ) : null}

            {advanced ? (
              <dl className="page-list">
                {lines.map((line) => (
                  <div key={line.label} className="rule-head">
                    <span className="rule-condition">{line.label}</span>
                    <span className="rule-name">{line.value}</span>
                  </div>
                ))}
              </dl>
            ) : null}
          </div>

          {busy ? (
            <p className="nr-notice">
              <LoaderCircle className="page-status is-pending" aria-hidden="true" />
              Complete the approval card to publish the rule.
            </p>
          ) : message ? (
            <p className="nr-notice" role="status">
              {message}
              {resultHash ? (
                <>
                  {" "}
                  <ExplorerLink target={resultHash} kind="tx" />
                </>
              ) : null}
            </p>
          ) : null}
        </>
      ) : (
        <div className="rule-card">
          <div className="rule-head">
            <CircleAlert className="rule-icon" aria-hidden="true" />
            <span className="rule-name">
              {state === "error" ? "Could not read the rules" : "Rules unavailable"}
            </span>
          </div>
          <p className="rule-body">
            <span className="rule-condition">{detail}</span>
          </p>
          {state === "error" ? (
            <button type="button" className="rule-add" onClick={editor.refresh}>
              <RefreshCw aria-hidden="true" />
              Retry
            </button>
          ) : null}
        </div>
      )}
    </>
  );
}
