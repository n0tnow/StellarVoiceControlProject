import type { PolarisEvent } from "@polaris/interfaces";

export type PolarisEventHandler = (event: PolarisEvent) => void;

/**
 * Minimal typed pub/sub used to move `PolarisEvent`s from the agent core to the
 * shell. Step A2 pipes this bus into the Tauri event channel
 * (`POLARIS_EVENT_NAME`), which is what the log pane in `app/` renders.
 */
export class PolarisEventBus {
  readonly #handlers = new Set<PolarisEventHandler>();

  subscribe(handler: PolarisEventHandler): () => void {
    this.#handlers.add(handler);
    return () => {
      this.#handlers.delete(handler);
    };
  }

  emit(event: PolarisEvent): void {
    for (const handler of this.#handlers) {
      handler(event);
    }
  }
}

export function createEventBus(): PolarisEventBus {
  return new PolarisEventBus();
}