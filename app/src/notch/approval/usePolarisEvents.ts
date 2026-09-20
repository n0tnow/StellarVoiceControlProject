/**
 * Subscribes a notch component to the typed `polaris-event` stream while it is
 * mounted, shared by the inline approval overlay.
 */
import { useEffect } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { PolarisEvent } from "@polaris/interfaces";

import { listenPolarisEvents } from "@/lib/polaris";

export function usePolarisEvents(handler: (event: PolarisEvent) => void): void {
  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    void listenPolarisEvents((event) => {
      if (!disposed) handler(event);
    })
      .then((stop) => {
        // The listener may resolve after unmount in StrictMode.
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((error: unknown) => {
        console.warn("approval overlay could not subscribe to polaris-event", error);
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [handler]);
}
