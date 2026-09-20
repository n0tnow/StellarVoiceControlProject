/**
 * Page 5 — where Autonomy lives.
 *
 * ## This page illustrates; it does not test. Here is why.
 *
 * The brief asked for a page the user passes by really hovering the notch, with
 * an explicit instruction to fall back to illustration if that turns out to be
 * undetectable from a focused window. It is undetectable, and the evidence is
 * laid out in full on [`useNotchHoverProbe`]: macOS pauses the *global*
 * `mouseMoved` monitor while Autonomy is the active app — `notch.rs` ships that
 * sentence as a user-facing diagnostic, and `lib.rs` resigns active after
 * closing a panel purely to undo it — while the *local* monitor never sees a
 * cursor over the notch because the overlay is `ignoresMouseEvents`. The
 * onboarding window is focusable and frontmost, so both halves are blind at the
 * same time.
 *
 * So this page shows an accurate, animated recreation of the notch expanding,
 * built in CSS on the shell's own 470ms / `cubic-bezier(0.32, 0.72, 0, 1)` —
 * the real transition, at a smaller size. A recreation is not a consolation
 * prize here: the user cannot see the real notch anyway while a 900x640 window
 * is centred over their screen, so a faithful diagram in front of them is a
 * better teacher than a live surface they are not looking at.
 *
 * The hover probe is still subscribed. If a real `notch_hover` arrives — because
 * the Rust side later grows a monitor that covers this case, or because the
 * user's setup does something we did not predict — the page notices and says so.
 * It can only ever add a confirmation, never withhold one, which is precisely
 * what makes it safe to leave in.
 */
import { useState } from "react";

import { CheckIcon } from "../icons.tsx";
import { useNotchHoverProbe } from "../useShortcutProbe.ts";

export interface NotchPageProps {
  readonly active: boolean;
  readonly onAdvance: () => void;
}

export function NotchPage({ active, onAdvance }: NotchPageProps) {
  const [sawHover, setSawHover] = useState(false);
  useNotchHoverProbe(() => setSawHover(true), active && !sawHover);

  return (
    <>
      {/* The recreation. Purely decorative — the copy below carries the whole
          lesson in words — so it stays out of the accessibility tree. */}
      <div className="ob-display" aria-hidden>
        <div className="ob-display-notch">
          <span className="ob-display-bar" />
          <span className="ob-display-bar" />
        </div>
      </div>

      <h1 className="ob-title">It lives in the notch</h1>
      <p className="ob-body">
        Autonomy has no window and no icon in your menu bar. Move the pointer over
        the notch and it opens; move away and it is gone again.
      </p>

      <div className={`ob-lesson-status${sawHover ? " is-passed" : ""}`}>
        {sawHover ? (
          <>
            <CheckIcon />
            There it is.
          </>
        ) : (
          "Try it once this window is closed."
        )}
      </div>

      <div className="ob-actions">
        <button type="button" className="ob-button ob-button-primary" onClick={onAdvance}>
          Continue
        </button>
      </div>
    </>
  );
}
