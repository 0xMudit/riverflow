"use client";

import { useMemo, useState } from "react";
import { ChainBlock } from "@/components/ChainBlock";
import { Shell } from "@/components/Shell";
import { Toast } from "@/components/Toast";
import { plural } from "@/lib/format";
import { verifyChain } from "@/lib/river/chain";
import type { Block, ChainError, VerificationReport } from "@/lib/river/types";
import { useRiver } from "@/lib/useRiver";
import { useToast } from "@/lib/useToast";

interface TamperState {
  blocks: Block[];
  report: VerificationReport;
  index: number;
}

export default function ChainPage() {
  const { data, identity, submit, refresh } = useRiver(8000);
  const { message, notify } = useToast();
  const [tamper, setTamperState] = useState<TamperState | null>(null);

  const blocks = tamper?.blocks ?? data?.blocks ?? [];
  const report = tamper?.report ?? data?.report ?? null;

  const errorsByBlock = useMemo(() => {
    const map = new Map<number, ChainError[]>();
    for (const error of report?.errors ?? []) {
      const list = map.get(error.block) ?? [];
      list.push(error);
      map.set(error.block, list);
    }
    return map;
  }, [report]);

  const attemptErasure = async () => {
    const source = data?.blocks ?? [];
    if (source.length < 2) {
      notify("The chain is too young to break meaningfully");
      return;
    }
    // Pick a middle block that actually holds an event: the damage cascades.
    const candidates = source
      .map((block, index) => ({ block, index }))
      .filter((entry) => entry.index > 0 && entry.block.events.length > 0);
    const target = candidates[Math.floor(candidates.length / 2)] ?? candidates[0];
    if (!target) {
      notify("No events to erase yet");
      return;
    }

    const copy = structuredClone(source);
    copy[target.index].events.splice(0, 1);
    // Fresh verification: no signature cache, so nothing is taken on faith.
    const nextReport = await verifyChain(copy);
    setTamperState({ blocks: copy, report: nextReport, index: target.index });
    notify(`You removed one event from block #${target.index}. Look what happens.`);
  };

  const head = blocks[blocks.length - 1];
  const ok = report?.ok ?? true;

  return (
    <>
      <Shell
        state={data?.state ?? null}
        report={data?.report ?? null}
        blocks={data?.blocks ?? []}
        identity={identity}
        submit={submit}
        notify={notify}
      >
        <header style={{ padding: "20px 0 0" }}>
          <h1 className="serif" style={{ fontSize: 23, lineHeight: 1.1, letterSpacing: "-0.01em" }}>
            The ledger
          </h1>
          <p className="meta" style={{ marginTop: 6 }}>
            {report
              ? `${plural(blocks.length, "block")} · ${plural(report.events, "event")} · difficulty ${head?.difficulty ?? "?"}`
              : "reading the ledger…"}
          </p>
        </header>

        <section
          className="panel"
          style={{
            marginTop: 18,
            padding: "14px 16px",
            borderColor: tamper ? "rgba(229,118,106,0.42)" : undefined,
            background: tamper ? "rgba(229,118,106,0.05)" : undefined,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: 99,
                background: tamper ? "var(--danger)" : ok ? "var(--water)" : "var(--danger)",
                boxShadow: tamper || !ok ? "0 0 9px rgba(229,118,106,0.8)" : "0 0 9px rgba(91,217,194,0.8)",
              }}
            />
            <strong style={{ fontSize: 13.5, fontWeight: 600 }}>
              {tamper
                ? "The chain no longer verifies"
                : ok
                  ? "Chain intact"
                  : "Chain does not verify"}
            </strong>
            <span className="meta" style={{ marginLeft: "auto" }}>
              {report ? `${plural(report.errors.length, "error")}` : ""}
            </span>
          </div>

          <p
            className="serif"
            style={{ fontSize: 13, lineHeight: 1.6, color: "var(--ink-dim)", marginTop: 8 }}
          >
            {tamper
              ? `You removed one event from block #${tamper.index} in a copy held in memory. Its merkle root no longer matches, its hash no longer matches, and every block above it now points at a parent that does not exist. The real ledger on disk was never touched.`
              : "Every block is re-hashed and every signature re-checked in this browser, from genesis to head. Nothing here is taken on the server's word."}
          </p>

          <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            {tamper ? (
              <button className="btn btn-primary" onClick={() => setTamperState(null)}>
                Let go of the copy
              </button>
            ) : (
              <>
                <button className="btn" onClick={() => void refresh()}>
                  Re-verify
                </button>
                <button className="btn btn-danger" onClick={() => void attemptErasure()}>
                  Try to erase an event
                </button>
              </>
            )}
          </div>

          {tamper && (
            <ul style={{ margin: "12px 0 0", paddingLeft: 16, fontSize: 11.5, color: "var(--danger)" }}>
              {tamper.report.errors.slice(0, 6).map((error, index) => (
                <li key={index} style={{ marginTop: 4 }}>
                  <span className="mono">
                    block #{error.block} · {error.code}
                  </span>{" "}
                  — {error.detail}
                </li>
              ))}
              {tamper.report.errors.length > 6 && (
                <li style={{ marginTop: 4, color: "var(--ink-faint)" }}>
                  …and {tamper.report.errors.length - 6} more.
                </li>
              )}
            </ul>
          )}
        </section>

        <div style={{ marginTop: 22 }}>
          <div
            className="label"
            style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}
          >
            <span>Blocks, newest first</span>
            <span className="mono" style={{ letterSpacing: 0, textTransform: "none" }}>
              {head ? head.hash.slice(0, 16) : ""}
            </span>
          </div>

          {[...blocks].reverse().map((block) => (
            <ChainBlock
              key={`${block.index}-${block.hash}`}
              block={block}
              errors={errorsByBlock.get(block.index) ?? []}
              eventValidity={report?.eventValidity ?? {}}
              tampered={tamper?.index === block.index}
            />
          ))}

          {blocks.length === 0 && (
            <p className="meta" style={{ padding: "20px 0" }}>
              Nothing on the ledger yet.
            </p>
          )}
        </div>

        <p className="meta" style={{ marginTop: 24, lineHeight: 1.7 }}>
          Each block stores the hash of the block before it. To rewrite one post you would have to
          re-mine every block after it — and the rest of the network would still hold the original
          head.
        </p>
      </Shell>

      <Toast message={message} />
    </>
  );
}
