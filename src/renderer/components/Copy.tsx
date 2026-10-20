"use client";

import { useState } from "react";
import { shortHash } from "@/renderer/format";

export function Copyable({
  value,
  label,
  className = "chip",
  title,
}: {
  value: string;
  label: string;
  className?: string;
  title?: string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* Clipboard can be blocked; the value is still visible on screen. */
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      className={className}
      title={title ?? value}
      style={{ cursor: "pointer" }}
    >
      {copied ? "copied" : label}
    </button>
  );
}

export function HashChip({ hash, label }: { hash: string; label?: string }) {
  return <Copyable value={hash} label={label ?? shortHash(hash)} className="chip" />;
}
