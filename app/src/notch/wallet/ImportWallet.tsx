/**
 * "Connect an existing account" flow (task W10b, extended by W19).
 *
 * One screen, two visible inputs: the secret key (`S…`) or 12/24-word phrase,
 * and a nickname (blank falls back to `Account N`). The value is validated live,
 * previewed to show the derived address, and only stored after an explicit
 * confirmation. The field is cleared on submit, cancel and failure; the value
 * never reaches a log, the URL, local storage or the agent, only the Rust
 * engine's typed command. A small text link offers creating a fresh wallet
 * instead, where the engine allows it.
 */
import { useReducer, useState } from "react";

import { Button } from "@/components/ui/button";
import { walletEngine, WalletEngineError } from "@/lib/wallet";
import {
  CONNECT_COPY,
  defaultAccountLabel,
  initialImportState,
  normalizeAccountLabel,
  parseImportIndex,
  reduceImport,
  validateAccountLabel,
  validateImportIndex,
  validateImportValue,
} from "@/lib/walletFlows";

import { ACTIONS, CARD, ERROR, FIELD, HINT } from "./styles";

export interface ImportWalletProps {
  onDone: (address: string) => void;
  onCancel: () => void;
  /** Heading line; defaults to the connect-existing copy. */
  heading?: string;
  /** Nickname used when the name field is left blank. */
  defaultLabel?: string;
  /** Existing nicknames, so a duplicate is refused before the store call. */
  existingLabels?: readonly string[];
  /** When set, offers "Create a new wallet" as a small text alternative. */
  onCreate?: () => void;
}

/** One plain line for a rejected import; a duplicate account is not an error. */
function importError(failure: unknown): string {
  if (failure instanceof WalletEngineError && failure.kind === "exists") {
    return "That account is already added.";
  }
  return failure instanceof Error ? failure.message : String(failure);
}

export function ImportWallet({
  onDone,
  onCancel,
  heading = CONNECT_COPY.importHeading,
  defaultLabel,
  existingLabels = [],
  onCreate,
}: ImportWalletProps) {
  const [state, dispatch] = useReducer(reduceImport, initialImportState);
  const [attempted, setAttempted] = useState(false);

  const valueError = validateImportValue(state.mode, state.secret);
  const indexError = validateImportIndex(state.index);
  const nameError = validateAccountLabel(state.name, existingLabels);
  const label = normalizeAccountLabel(
    state.name,
    defaultLabel ?? defaultAccountLabel(existingLabels.length),
  );

  const inputArgs = (): { secretOrPhrase: string; index?: number } => {
    const index = parseImportIndex(state.index);
    return { secretOrPhrase: state.secret, ...(index === undefined ? {} : { index }) };
  };

  const preview = async (): Promise<void> => {
    setAttempted(true);
    if (valueError !== null || indexError !== null || nameError !== null) return;
    dispatch({ type: "preview" });
    try {
      const result = await walletEngine.importPreview(inputArgs());
      dispatch({ type: "previewed", address: result.address });
    } catch (failure) {
      dispatch({ type: "failed", error: importError(failure) });
    }
  };

  const confirm = async (): Promise<void> => {
    // Capture the value, then clear it before the async store resolves.
    const args = { ...inputArgs(), label };
    dispatch({ type: "store" });
    try {
      const result = await walletEngine.import(args);
      dispatch({ type: "stored", address: result.address });
      onDone(result.address);
    } catch (failure) {
      dispatch({ type: "failed", error: importError(failure) });
    }
  };

  if (state.step === "preview") {
    return (
      <section className={CARD}>
        <h2 className="text-sm font-semibold">{CONNECT_COPY.previewHeading}</h2>
        <p className={HINT}>{label}</p>
        <code className="wallet-key-value selectable">{state.address}</code>
        <div className={ACTIONS}>
          <Button size="sm" onClick={() => void confirm()}>
            {CONNECT_COPY.confirm}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => dispatch({ type: "back" })}>
            Back
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section className={CARD}>
      <h2 className="text-sm font-semibold">{heading}</h2>
      <div className={ACTIONS} role="group" aria-label="Connect type">
        <Button
          size="sm"
          variant={state.mode === "secret" ? "secondary" : "ghost"}
          onClick={() => dispatch({ type: "mode", mode: "secret" })}
        >
          Secret key
        </Button>
        <Button
          size="sm"
          variant={state.mode === "phrase" ? "secondary" : "ghost"}
          onClick={() => dispatch({ type: "mode", mode: "phrase" })}
        >
          Recovery phrase
        </Button>
      </div>

      <label className="block text-[11px] text-polaris-muted">
        {state.mode === "secret" ? "Secret key (S…)" : "Recovery phrase (12 or 24 words)"}
        <input
          className={FIELD}
          type="password"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          value={state.secret}
          onChange={(event) => dispatch({ type: "secret", value: event.target.value })}
        />
      </label>

      <label className="block text-[11px] text-polaris-muted">
        Name
        <input
          className={FIELD}
          type="text"
          autoComplete="off"
          spellCheck={false}
          placeholder="e.g. acc1"
          value={state.name}
          onChange={(event) => dispatch({ type: "name", value: event.target.value })}
        />
      </label>

      {attempted && valueError !== null ? <p className={ERROR}>{valueError}</p> : null}
      {attempted && nameError !== null ? <p className={ERROR}>{nameError}</p> : null}
      {state.error !== null ? <p className={ERROR}>{state.error}</p> : null}

      <div className={ACTIONS}>
        <Button size="sm" disabled={state.step === "previewing"} onClick={() => void preview()}>
          {state.step === "previewing" ? "Deriving…" : "Preview address"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            dispatch({ type: "reset" });
            onCancel();
          }}
        >
          Cancel
        </Button>
      </div>

      {onCreate !== undefined ? (
        <button
          type="button"
          className="text-[11px] text-[var(--color-notch-muted)] hover:text-[var(--color-notch-text)]"
          onClick={onCreate}
        >
          Create a new wallet instead
        </button>
      ) : null}
    </section>
  );
}
