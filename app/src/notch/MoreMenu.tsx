/**
 * The notch "⋯" menu (task RMTRAY).
 *
 * Replaces the removed menu-bar tray: the expanded notch panel is the only
 * surface, and this small menu is how every ordinary panel window and Quit are
 * reached. The entries live in `@/lib/panels` (`MORE_MENU`) next to `openPanel`
 * and `quitPolaris`, so the menu and the panel seam share one list.
 *
 * Presentation only: opening a panel is the existing `open_panel` command and
 * quitting is the new `quit_app` command. Escape and a click outside close the
 * menu; the trigger and every item are real buttons, so it is keyboard
 * reachable.
 */
import { useEffect, useRef, useState } from "react";
import { Ellipsis } from "lucide-react";

import { MORE_MENU, quitPolaris, openPanel, type MoreMenuEntry } from "@/lib/panels";

function runEntry(entry: MoreMenuEntry): void {
  if ("quit" in entry) {
    void quitPolaris().catch((error: unknown) => {
      console.warn("quit failed", error);
    });
    return;
  }
  void openPanel(entry.panel).catch((error: unknown) => {
    console.warn(`opening ${entry.panel} failed`, error);
  });
}

export function MoreMenu() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const firstItemRef = useRef<HTMLButtonElement>(null);

  // While open: focus the first item, close on Escape (returning focus to the
  // trigger) and close on any pointer press outside the menu.
  useEffect(() => {
    if (!open) return;
    firstItemRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="pointer-events-auto absolute bottom-3 right-3 z-10">
      <button
        ref={triggerRef}
        type="button"
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--color-notch-muted)] transition-colors hover:bg-white/10 hover:text-[var(--color-notch-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-notch-accent)]"
      >
        <Ellipsis aria-hidden="true" className="h-4 w-4" />
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="Polaris"
          className="absolute right-0 bottom-full mb-1 w-44 overflow-hidden rounded-xl border border-white/10 bg-[#0b0b0d]/95 p-1 shadow-xl backdrop-blur"
        >
          {MORE_MENU.map((entry, index) => (
            <button
              key={entry.label}
              ref={index === 0 ? firstItemRef : undefined}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                runEntry(entry);
              }}
              className="flex w-full items-center rounded-lg px-3 py-1.5 text-left text-[13px] text-[var(--color-notch-muted)] transition-colors hover:bg-white/10 hover:text-[var(--color-notch-text)] focus-visible:bg-white/10 focus-visible:text-[var(--color-notch-text)] focus-visible:outline-none"
            >
              {entry.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
