/**
 * The notch Rules page: one plain-language sentence, one control, Save.
 *
 * The top line reads the live on-chain rule in plain English. The single
 * "Ask me only above" field plus Save creates or updates that rule through the
 * existing auto-pay flow (`guard_policy` intent → batch approval card → ONE
 * Touch ID), so the executor key is set up automatically and the page never
 * builds or signs a transaction itself. `Advanced` reveals the per-payment and
 * per-day limits, the recipient policy and the current on-chain read-back.
 *
 * Locked/loading/error states are rendered here; the wallet gate lives in
 * `RulesPage`. No mock rule is ever shown for a configured owner.
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
    message,
    resultHash,
  } = editor;
  const [advanced, setAdvanced] = useState(false);

  if (state === "loading") return <p className="rule-condition">Reading spending rules…</p>;

  if (state === "unconfigured" || state === "error") {
    return (
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
    );
  }

  const symbol = security?.assetSymbol ?? "XLM";
  const armed = security?.executor != null && (security.rule?.auto_approve_limit ?? 0n) > 0n;
  const disabled = busy || security === null;
  const lines = security ? rulesView(security, contacts, executorFunded) : [];

  return (
    <>
      {!autoPaySupported ? (
        <p className="rule-condition">
          Automatic payments aren&apos;t enabled in this build yet — save is disabled.
        </p>
      ) : null}

      <p className="rule-body">
        <span className="rule-name">{security ? ruleSummary(security, symbol) : ""}</span>
      </p>

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
            <span className="rule-condition">Saved contacts only</span>
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
          className="rule-add"
          aria-expanded={advanced}
          onClick={() => setAdvanced((value) => !value)}
        >
          <ChevronDown aria-hidden="true" />
          {advanced ? "Hide advanced" : "Advanced"}
        </button>

        {armed ? (
          <button type="button" className="rule-add" disabled={disabled} onClick={() => void editor.disable()}>
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
        <p className="task-schedule">
          <LoaderCircle className="page-status is-pending" aria-hidden="true" />
          Complete the approval card to publish the rule.
        </p>
      ) : message ? (
        <p className="rule-condition" role="status">
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
  );
}
