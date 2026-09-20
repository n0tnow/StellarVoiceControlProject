/**
 * Renders a QR code for the Receive card (task W13b).
 *
 * The encoder is dependency-free (`@/lib/qr`) and is imported lazily, so the
 * main shell bundle does not carry it until a Receive card is actually shown.
 */
import { useEffect, useState } from "react";

import type { QrMatrix } from "@/lib/qr";

export interface QrCodeProps {
  value: string;
  /** Rendered side length in CSS pixels. */
  size?: number;
}

function modulesPath(matrix: QrMatrix): string {
  const parts: string[] = [];
  for (let y = 0; y < matrix.size; y += 1) {
    for (let x = 0; x < matrix.size; x += 1) {
      if (matrix.modules[y]?.[x]) parts.push(`M${x} ${y}h1v1h-1z`);
    }
  }
  return parts.join("");
}

export function QrCode({ value, size = 132 }: QrCodeProps) {
  const [matrix, setMatrix] = useState<QrMatrix | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void import("@/lib/qr")
      .then(({ encodeQr }) => {
        if (cancelled) return;
        setFailed(false);
        setMatrix(encodeQr(value));
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [value]);

  if (failed) return <p className="wallet-key-label">QR code unavailable</p>;
  if (matrix === null) return <p className="wallet-key-label">Preparing QR…</p>;

  return (
    <svg
      className="rounded-lg bg-white p-1.5"
      width={size}
      height={size}
      viewBox={`0 0 ${matrix.size} ${matrix.size}`}
      role="img"
      aria-label={`QR code for ${value}`}
      shapeRendering="crispEdges"
    >
      <path d={modulesPath(matrix)} fill="#000" />
    </svg>
  );
}
