import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { describeIntent, type SpokenResult } from "@polaris/agent";

import { runAgentTurn, type AgentRun } from "@/lib/agent";
import { speakTurnResult } from "@/lib/speech";
import type { VoiceStage } from "./shellState";

/**
 * The typed-prompt body (folded A6).
 *
 * This component is the `prompt` shell state's body: it renders inside the
 * notch webview and holds the text entry, the speak-replies glyph and the agent
 * answer. It does not own a window, a sheet or an animation — the shell does.
 * Its measured height is reported to the shell owner, which passes it to Rust so
 * the *notch itself* grows (and scrolls past the max) instead of a floating
 * panel.
 *
 * Deliberately one surface: no header bar, no close button, no nested input
 * card. Dismissal is Escape (outside click / the double-Control trigger are
 * handled by the shell), so the body is a single text row with a small
 * low-contrast speaker glyph, and the answer (or a single muted error line)
 * appears under it.
 *
 * The answer goes through the same agent pipeline as the voice path
 * (`runAgentTurn`, the same `@/lib/agent` the overlay uses) and, when the
 * speaker switch is on, the same TTS path (`speakTurnResult`).
 */

/** localStorage key for the speaker switch. `"off"` is the only opt-out value. */
const SPEAKER_KEY = "polaris.prompt.speaker";

/** The textarea grows with its content up to this many pixels, then scrolls. */
const MAX_TEXTAREA_HEIGHT = 140;

/** Default when nothing is stored: speak the answer. */
function loadSpeakerPreference(): boolean {
  try {
    return window.localStorage.getItem(SPEAKER_KEY) !== "off";
  } catch {
    // Private mode / storage disabled: fall back to the default.
    return true;
  }
}

function storeSpeakerPreference(on: boolean): void {
  try {
    window.localStorage.setItem(SPEAKER_KEY, on ? "on" : "off");
  } catch {
    // Persisting is best-effort; the in-memory choice still applies.
  }
}

export interface PromptPanelProps {
  /**
   * Reports the measured natural body height. Rust clamps it between the
   * state's min and max and returns the value to apply; the shell owner owns
   * that round-trip and the resize.
   */
  onContentHeight: (bodyHeight: number) => void;
  /** Dismiss the prompt. The shell turns this into a state transition. */
  onDismiss: () => void;
  /**
   * The live voice turn's stage, or `null` when no turn is running. The shell
   * can hold the prompt *and* a voice turn at the same time (the reducer keeps
   * the prompt on top), and the strip that used to show the stage is not
   * rendered in this state — so the stage is surfaced here as a small inline
   * indicator at the right end of the input row.
   */
  voiceStage: VoiceStage | null;
}

export function PromptPanel({ onContentHeight, onDismiss, voiceStage }: PromptPanelProps) {
  const [text, setText] = useState("");
  const [thinking, setThinking] = useState(false);
  const [result, setResult] = useState<AgentRun | null>(null);
  const [speakerOn, setSpeakerOn] = useState(loadSpeakerPreference);

  const bodyRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // One in-flight turn at a time, even across a StrictMode double render.
  const busyRef = useRef(false);

  // The measured element is the body, whose `max-height` is the shell's
  // content cap. Its rect is therefore already clamped, so the shell and the
  // scroll area agree on where the content ends.
  useEffect(() => {
    const node = bodyRef.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      onContentHeight(node.getBoundingClientRect().height);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [onContentHeight]);

  // The native window takes keyboard focus when the prompt state is requested;
  // focus the field so typing lands in it immediately.
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Auto-grow the single-line field up to the cap.
  useLayoutEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  }, [text]);

  const submit = useCallback(async () => {
    const prompt = text.trim();
    if (prompt.length === 0 || busyRef.current) return;
    busyRef.current = true;
    setThinking(true);
    setResult(null);
    try {
      const run = await runAgentTurn(prompt);
      setResult(run);
      // Render first, then speak: `speakTurnResult` returns immediately, so a
      // slow TTS backend never delays the answer. When the switch is off,
      // nothing is synthesized at all.
      if (run.ok && speakerOn) {
        const spoken: SpokenResult = run.outcome.intent
          ? { answer: run.outcome.answer, intent: run.outcome.intent }
          : { answer: run.outcome.answer };
        speakTurnResult(spoken);
      }
    } finally {
      setThinking(false);
      busyRef.current = false;
    }
  }, [text, speakerOn]);

  const onTextareaKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter inserts a newline (the default is prevented only
    // for the send path).
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };

  const onRootKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onDismiss();
    }
  };

  const toggleSpeaker = () => {
    setSpeakerOn((current) => {
      const next = !current;
      storeSpeakerPreference(next);
      return next;
    });
  };

  const hasText = text.trim().length > 0;

  return (
    <main className="notch-prompt" onKeyDown={onRootKeyDown} aria-label="Ask Polaris">
      <div className="notch-prompt-body" ref={bodyRef}>
        <div className="prompt-row">
          <textarea
            ref={textareaRef}
            className="prompt-field selectable"
            rows={1}
            placeholder="Ask Polaris…"
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onTextareaKeyDown}
            aria-label="Ask Polaris"
          />
          {/* Send affordance: a small, low-contrast glyph that only exists once
              there is text. Enter is the primary path. */}
          {hasText ? (
            <button
              type="button"
              className="prompt-send"
              onClick={() => void submit()}
              disabled={thinking}
              aria-label="Send"
              title="Send"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="m5 12 7-7 7 7" />
                <path d="M12 19V5" />
              </svg>
            </button>
          ) : null}
          {/* Spoken replies: a glyph, not a labelled pill. On/off is the glyph
              shape plus opacity; the accessible name carries the state. */}
          <button
            type="button"
            className={`prompt-speaker${speakerOn ? " is-on" : ""}`}
            onClick={toggleSpeaker}
            aria-label={speakerOn ? "Spoken replies on" : "Spoken replies off"}
            aria-pressed={speakerOn}
            title={speakerOn ? "Spoken replies on" : "Spoken replies off"}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M11 5 6 9H2v6h4l5 4V5z" />
              {speakerOn ? (
                <>
                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                </>
              ) : (
                <>
                  <path d="m22 9-6 6" />
                  <path d="m16 9 6 6" />
                </>
              )}
            </svg>
          </button>
          {/* A voice turn can be live while the prompt is open. The status strip
              (the other stage affordance) is not rendered in this state, so the
              stage appears here instead: three bars in the notch's own accent,
              animated by the same `state-*` rules the strip uses. It is
              decorative — the live region in `App` carries the stage to AT — and
              it is not rendered at all once the turn settles, so the prompt
              returns to exactly its normal look. */}
          {voiceStage !== null ? (
            <span className="prompt-voice" data-stage={voiceStage} aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          ) : null}
        </div>

        {thinking || result ? (
          <div className="prompt-answer" role="status" aria-live="polite">
            {thinking ? <p className="prompt-thinking">Thinking…</p> : renderResult(result)}
          </div>
        ) : null}
      </div>
    </main>
  );
}

function renderResult(run: AgentRun | null) {
  if (run === null) return null;
  if (!run.ok) {
    // One compact muted line: the full text stays available via `title` instead
    // of a two-line shouting block.
    const message = `${run.failure.label}: ${run.failure.detail}`;
    return (
      <p className="prompt-error" title={message}>
        {message}
      </p>
    );
  }
  return (
    <>
      {run.outcome.intent ? (
        <p className="prompt-intent">{describeIntent(run.outcome.intent)}</p>
      ) : null}
      <p className="prompt-text">{run.outcome.answer}</p>
    </>
  );
}
