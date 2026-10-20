"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import { Copyable } from "@/components/Copy";
import { shortAddr, shortHash, timeAgo } from "@/lib/format";
import type { Block, ChainError } from "@/lib/river/types";

function Seal({ ok }: { ok: boolean }) {
  return (
    <span
      className="mono"
      style={{ fontSize: 10.5, color: ok ? "var(--water)" : "var(--danger)" }}
      title={ok ? "verified" : "invalid"}
    >
      {ok ? "✓" : "✗"}
    </span>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "84px 1fr", gap: 10, padding: "4px 0" }}>
      <span className="label" style={{ fontSize: 9, paddingTop: 2 }}>
        {label}
      </span>
      <span className="mono" style={{ fontSize: 10.5, color: "var(--ink-dim)", overflowWrap: "anywhere" }}>
        {children}
      </span>
    </div>
  );
}

export function ChainBlock({
  block,
  errors,
  eventValidity,
  tampered,
}: {
  block: Block;
  errors: ChainError[];
  eventValidity: Record<string, boolean>;
  tampered: boolean;
}) {
  const [open, setOpen] = useState(false);
  const broken = errors.length > 0;

  return (
    <div className="chain-block" data-tampered={tampered} style={{ marginBottom: 8 }}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 12px",
          background: "transparent",
          border: 0,
          cursor: "pointer",
          textAlign: "left",
          color: "inherit",
        }}
        aria-expanded={open}
      >
        <span className="mono" style={{ fontSize: 12, color: "var(--ink)", minWidth: 42 }}>
          #{block.index}
        </span>
        <span className="meta" style={{ minWidth: 46 }}>
          {timeAgo(block.timestamp)}
        </span>
        <span className="meta" style={{ minWidth: 62 }}>
          {block.events.length} event{block.events.length === 1 ? "" : "s"}
        </span>
        <span className="mono" style={{ fontSize: 10.5, color: "var(--ink-faint)", flex: 1, minWidth: 0 }}>
          {shortHash(block.hash, 12, 8)}
        </span>
        {broken ? <span className="chip chip-bad">{errors[0].code}</span> : <span className="chip chip-water">sealed</span>}
        <span className="meta" style={{ fontSize: 10 }}>
          {open ? "−" : "+"}
        </span>
      </button>

      {open && (
        <div style={{ padding: "6px 12px 12px", borderTop: "1px solid var(--line)" }}>
          <Row label="hash">
            <Copyable value={block.hash} label={block.hash} className="mono" />
          </Row>
          <Row label="prev">
            {block.index === 0 ? "genesis" : block.prevHash}
          </Row>
          <Row label="merkle">{block.merkleRoot}</Row>
          <Row label="work">
            difficulty {block.difficulty} · nonce {block.nonce}
          </Row>
          <Row label="time">{new Date(block.timestamp).toISOString()}</Row>

          {block.events.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div className="label" style={{ fontSize: 9, marginBottom: 6 }}>
                Events
              </div>
              {block.events.map((event) => (
                <div
                  key={event.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "62px 1fr auto",
                    gap: 8,
                    alignItems: "baseline",
                    padding: "5px 0",
                    borderTop: "1px dotted var(--line)",
                  }}
                >
                  <span className="label" style={{ fontSize: 9 }}>
                    {event.kind}
                  </span>
                  <span className="mono" style={{ fontSize: 10.5, color: "var(--ink-dim)", overflowWrap: "anywhere" }}>
                    {shortAddr(event.author)}{" "}
                    <span style={{ color: "var(--ink-faint)" }}>
                      {event.body.text
                        ? `“${event.body.text.slice(0, 60)}${event.body.text.length > 60 ? "…" : ""}”`
                        : event.body.name
                          ? `name → ${event.body.name}`
                          : event.body.target
                            ? `→ ${shortHash(event.body.target, 6, 4)}`
                            : ""}
                    </span>
                  </span>
                  <Seal ok={eventValidity[event.id] !== false} />
                </div>
              ))}
            </div>
          )}

          {broken && (
            <ul style={{ margin: "10px 0 0", paddingLeft: 14, color: "var(--danger)", fontSize: 11 }}>
              {errors.map((error, index) => (
                <li key={index} style={{ marginTop: 3 }}>
                  {error.detail}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
