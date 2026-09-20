/**
 * React half of the page-routing seam (see `notchPage.ts` for the pure part).
 *
 * The hook owns the active page plus the escape hatch any outside caller —
 * nav click today, voice command tomorrow — uses. It deliberately knows
 * nothing about the shell state machine: the caller wires `close()` to the
 * shell's `dismiss` so leaving the panel (pointer leaves, Escape in the
 * follow-up polish) is one call.
 */
import { useCallback, useState } from "react";

import {
  DEFAULT_NOTCH_PAGE,
  coerceNotchPage,
  type NotchPage,
} from "./notchPage";

export interface NotchPageController {
  /** The page currently shown in the panel. */
  page: NotchPage;
  /**
   * THE voice-command seam: `setNotchPage("history")` from a "geçmişi aç"
   * intent switches the panel to that page. Unknown strings fall back to the
   * default page instead of stranding the UI.
   */
  setNotchPage: (page: string) => void;
  /** Collapses the shell back out of the panel (wired to the shell's dismiss). */
  close: () => void;
}

export function useNotchPage(close: () => void): NotchPageController {
  const [page, setPage] = useState<NotchPage>(DEFAULT_NOTCH_PAGE);

  const setNotchPage = useCallback((requested: string): void => {
    setPage(coerceNotchPage(requested));
  }, []);

  return { page, setNotchPage, close };
}
