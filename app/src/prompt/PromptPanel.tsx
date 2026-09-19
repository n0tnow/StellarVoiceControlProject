import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { describeIntent, type SpokenResult } from "@polaris/agent";

import { runAgentTurn, type AgentRun } from "@/lib/agent";
import { speakTurnResult } from "@/lib/speech";

/**
 * The typed-prompt panel (step A6).
 *
 * Rust toggles this window on a double Control tap and tells the panel whether
 * to open or close on the `polaris-prompt` channel. The panel owns the sheet
 * animation and its own measured height; it reports the height back so Rust can
 * resize the native window, which is what makes the sheet read as "growing out
 * of the notch".
 *
 * The answer goes through the same agent pipeline as the voice path
 * (`runAgentTurn`, the same `@/lib/agent` the overlay uses) and, when the
 * speaker switch is on, the same TTS path (`speakTurnResult`, the same
 * `@/lib/speech` A4 uses). The speaker choice is per-user and persisted, not
 * per-answer.
 */

/** Event channel and payload shape, mirroring `prompt_window.rs`. */
const PROMPT_EVENT_NAME = "polaris-prompt";
interface PromptEvent {
  action: "open" | "close";
}

/** localStorage key for the speaker switch. `"off"` is the only opt-out value. */
const SPEAKER_KEY = "polaris.prompt.speaker";

/** Must match the `.prompt-sheet` height transition in `prompt.css`. */
const COLLAPSE_MS = 240;

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

export function PromptPanel() {
  const [expanded, setExpanded] = useState(false);
  const [sheetHeight, setSheetHeight] = useState(0);
  const [text, setText] = useState("");
  const [thinking, setThinking] = useState(false);
  const [result, setResult] = useState<AgentRun | null>(null);
  const [speakerOn, setSpeakerOn] = useState(loadSpeakerPreference);

  const innerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // One in-flight turn at a time, even across a StrictMode double render.
  const busyRef = useRef(false);

  /** Reports a measured height to Rust and remembers it for the animation. */
  const reportHeight = useCallback((height: number) => {
    const rounded = Math.round(height);
    if (rounded <= 0) return;
    setSheetHeight((current) => (current === rounded ? current : rounded));
    void invoke("prompt_resize", { height: rounded }).catch((error: unknown) => {
      console.warn("could not resize the prompt window", error);
    });
  }, []);

  // The measured element is `.prompt-inner`, whose height is the sheet's
  // natural height — independent of the animated `.prompt-sheet` height — so
  // content edits (streaming answer, growing textarea) drive the window size
  // exactly once per change.
  useEffect(() => {
    const node = innerRef.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      reportHeight(node.getBoundingClientRect().height);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [reportHeight]);

  const openPanel = useCallback(() => {
    if (hideTimer.current !== null) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
    // Measure synchronously: the panel may open before the observer's first
    // callback, and opening an unmeasured sheet would animate to nothing.
    const measured = innerRef.current?.getBoundingClientRect().height ?? 0;
    if (measured > 0) setSheetHeight(Math.round(measured));
    setExpanded(true);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  const closePanel = useCallback(() => {
    setExpanded(false);
    if (hideTimer.current !== null) clearTimeout(hideTimer.current);
    // Let the collapse animation play before hiding the native window.
    hideTimer.current = setTimeout(() => {
      hideTimer.current = null;
      void invoke("prompt_hide").catch((error: unknown) => {
        console.warn("could not hide the prompt window", error);
      });
    }, COLLAPSE_MS);
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    void listen<PromptEvent>(PROMPT_EVENT_NAME, (message) => {
      if (disposed) return;
      if (message.payload.action === "open") {
        openPanel();
      } else {
        closePanel();
      }
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((error: unknown) => {
        console.error("could not listen for prompt events", error);
      });

    return () => {
      disposed = true;
      unlisten?.();
      if (hideTimer.current !== null) {
        clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
    };
  }, [openPanel, closePanel]);

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
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };

  const onRootKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closePanel();
    }
  };

  const toggleSpeaker = () => {
    setSpeakerOn((current) => {
      const next = !current;
      storeSpeakerPreference(next);
      return next;
    });
  };

  const style = { "--sheet-height": `${sheetHeight}px` } as CSSProperties;

  return (
    <main className="prompt-root" onKeyDown={onRootKeyDown}>
      <section
        className={`prompt-sheet ${expanded ? "is-open" : ""}`}
        style={style}
        aria-label="Ask Polaris"
      >
        <div className="prompt-inner" ref={innerRef}>
          <header className="prompt-bar">
            <button
              type="button"
              role="switch"
              aria-checked={speakerOn}
              className="prompt-speaker"
              onClick={toggleSpeaker}
              title={speakerOn ? "Answer is spoken" : "Answer is text only"}
            >
              <span className="prompt-knob" aria-hidden="true" />
              <span>{speakerOn ? "Speak replies" : "Text only"}</span>
            </button>
            <button
              type="button"
              className="prompt-close"
              onClick={closePanel}
              aria-label="Close"
              title="Close"
            >
              ✕
            </button>
          </header>

          <div className="prompt-input">
            <textarea
              ref={textareaRef}
              className="prompt-field selectable"
              rows={1}
              placeholder="ask Polaris…"
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={onTextareaKeyDown}
              aria-label="Ask Polaris"
            />
            <button
              type="button"
              className="prompt-submit"
              onClick={() => void submit()}
              disabled={thinking || text.trim().length === 0}
              aria-label="Submit"
              title="Submit"
            >
              ↑
            </button>
          </div>

          {thinking || result ? (
            <div className="prompt-answer" role="status" aria-live="polite">
              {thinking ? (
                <p className="prompt-thinking">Thinking…</p>
              ) : (
                renderResult(result)
              )}
            </div>
          ) : null}
        </div>
      </section>
    </main>
  );
}

function renderResult(run: AgentRun | null) {
  if (run === null) return null;
  if (!run.ok) {
    return (
      <p className="prompt-error">
        <span className="prompt-tag">{run.failure.label}</span>
        {run.failure.detail}
      </p>
    );
  }
  return (
    <>
      {run.outcome.intent ? (
        <p className="prompt-intent">
          <span className="prompt-tag">intent</span>
          {describeIntent(run.outcome.intent)}
        </p>
      ) : null}
      <p className="prompt-text">{run.outcome.answer}</p>
    </>
  );
}
