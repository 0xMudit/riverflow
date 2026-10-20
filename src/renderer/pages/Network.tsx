import { useEffect, useState } from "react";
import type { BreachReport, IdentityInfo } from "@/core/bridge";
import type { Event, Snapshot, VerifyReport } from "@/core/types";
import { Copyable } from "../components/Copy";
import { plural, shortAddr, shortHash, timeAgo } from "../format";

type Mode = "verify" | "erase" | "rewrite";

export function NetworkPage({
  snapshot,
  identity,
  notify,
  onOpenProfile,
}: {
  snapshot: Snapshot;
  identity: IdentityInfo;
  notify: (message: string) => void;
  onOpenProfile: (pubkey: string) => void;
}) {
  const [report, setReport] = useState<(VerifyReport & { removedSeq?: number | null }) | null>(null);
  const [mode, setMode] = useState<Mode | null>(null);
  const [busy, setBusy] = useState(false);
  const [events, setEvents] = useState<Event[]>([]);
  const [address, setAddress] = useState("");

  const mySeq = snapshot.me?.seq ?? -1;

  useEffect(() => {
    let alive = true;
    void window.river
      .author(identity.publicKey)
      .then((bundle) => alive && setEvents(bundle.events))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [identity.publicKey, mySeq]);

  const run = async (next: Mode) => {
    setBusy(true);
    setMode(next);
    try {
      if (next === "verify") {
        const result = await window.river.verify();
        setReport(result);
        notify(result.ok ? `Verified ${plural(result.events, "event")} — every link and signature holds` : "Verification failed");
      } else {
        const result: BreachReport = await window.river.breach(next);
        setReport(result);
        notify(`Simulated ${next === "erase" ? "erasure" : "rewrite"} — the chain noticed`);
      }
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "could not run that check");
    } finally {
      setBusy(false);
    }
  };

  const addPeer = async () => {
    const target = address.trim();
    if (!target) return;
    const result = await window.river.dial(target);
    if (result.ok) {
      setAddress("");
      notify(`Dialling ${target}`);
    } else {
      notify(result.error ?? "could not connect");
    }
  };

  const breached = mode === "erase" || mode === "rewrite";

  return (
    <>
      <header style={{ padding: "20px 0 0" }}>
        <h1 className="serif" style={{ fontSize: 23, lineHeight: 1.1, letterSpacing: "-0.01em" }}>
          The network
        </h1>
        <p className="meta" style={{ marginTop: 6 }}>
          {plural(snapshot.peers.length, "peer")} · {plural(snapshot.stats.authors, "chain")} ·{" "}
          {plural(snapshot.stats.events, "event")} · this node is {identity.protected ? "key-sealed" : "running with a plaintext key"}
        </p>
      </header>

      <section
        className="panel"
        style={{
          marginTop: 18,
          padding: "14px 16px",
          borderColor: breached ? "rgba(229,118,106,0.42)" : undefined,
          background: breached ? "rgba(229,118,106,0.05)" : undefined,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: 99,
              background: report && !report.ok ? "var(--danger)" : "var(--water)",
              boxShadow: report && !report.ok ? "0 0 9px rgba(229,118,106,0.8)" : "0 0 9px rgba(91,217,194,0.8)",
            }}
          />
          <strong style={{ fontSize: 13.5, fontWeight: 600 }}>
            {!report
              ? "Integrity"
              : report.ok
                ? "Every chain verifies"
                : breached
                  ? "The chain broke immediately"
                  : "Verification failed"}
          </strong>
          <span className="meta" style={{ marginLeft: "auto" }}>
            {report ? `${report.events} events · ${report.durationMs}ms` : "not checked yet"}
          </span>
        </div>

        <p className="serif" style={{ fontSize: 13, lineHeight: 1.6, color: "var(--ink-dim)", marginTop: 8 }}>
          {breached
            ? `You ${mode === "erase" ? "removed one event" : "rewrote one event"}'s text in a copy held in memory. ${
                mode === "erase"
                  ? "Every later event still points at the missing one, so the chain reports a gap at that exact position."
                  : "The edit kept its old id, so the signature no longer covers the content."
              } The database on disk was never touched.`
            : "Each node re-hashes its own chains from seq 0 and checks every signature. Nothing is taken on faith, and no one has to be trusted with the check."}
        </p>

        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          <button className="btn" disabled={busy} onClick={() => void run("verify")}>
            {busy && mode === "verify" ? "checking…" : "Verify everything"}
          </button>
          <button className="btn btn-danger" disabled={busy} onClick={() => void run("erase")}>
            Try to erase an event
          </button>
          <button className="btn btn-danger" disabled={busy} onClick={() => void run("rewrite")}>
            Try to rewrite a post
          </button>
        </div>

        {report && report.errors.length > 0 && (
          <ul style={{ margin: "12px 0 0", paddingLeft: 16, fontSize: 11.5, color: "var(--danger)" }}>
            {report.errors.slice(0, 4).map((error, index) => (
              <li key={index} style={{ marginTop: 4 }}>
                <span className="mono">
                  seq {error.seq} · {error.code}
                </span>{" "}
                — {error.detail}
              </li>
            ))}
          </ul>
        )}

        {report?.ok && (
          <p className="meta" style={{ marginTop: 10 }}>
            {report.authors} chain{report.authors === 1 ? "" : "s"} checked, {report.events} signatures valid.
          </p>
        )}
      </section>

      <section style={{ marginTop: 26 }}>
        <div className="label" style={{ marginBottom: 10 }}>
          Peers
        </div>

        <div className="panel" style={{ padding: "12px 14px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span className="meta">your address</span>
            {snapshot.listen ? (
              <Copyable value={snapshot.listen} label={snapshot.listen} className="chip chip-water" />
            ) : (
              <span className="meta">none</span>
            )}
            <span className="meta" style={{ marginLeft: "auto", fontSize: 10 }}>
              {snapshot.peers.length === 0 ? "waiting for someone to dial in" : "gossiping"}
            </span>
          </div>

          <div style={{ display: "flex", gap: 6, marginTop: 12 }}>
            <input
              className="input mono"
              placeholder="192.168.1.20:7331"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void addPeer();
              }}
              style={{ fontSize: 12 }}
            />
            <button className="btn btn-primary" onClick={() => void addPeer()}>
              Connect
            </button>
          </div>

          <p className="meta" style={{ marginTop: 8, lineHeight: 1.6 }}>
            Nodes on the same network find each other automatically. To cross networks, share your
            address or dial theirs.
          </p>

          <div style={{ marginTop: 12 }}>
            {snapshot.peers.length === 0 && (
              <p className="meta" style={{ padding: "8px 0" }}>
                No one else is here yet.
              </p>
            )}
            {snapshot.peers.map((peer) => (
              <div
                key={peer.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr auto auto",
                  gap: 10,
                  alignItems: "baseline",
                  padding: "7px 0",
                  borderTop: "1px dotted var(--line)",
                }}
              >
                <span className="mono" style={{ fontSize: 11, color: "var(--ink)" }}>
                  {peer.id}
                </span>
                <span className="meta" style={{ fontSize: 10 }}>
                  {peer.address} · {peer.direction} · {peer.heads} chains
                </span>
                <span className="meta" style={{ fontSize: 10 }}>
                  {timeAgo(peer.since)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section style={{ marginTop: 26 }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
          <span className="label">Your chain</span>
          <span className="meta" style={{ fontSize: 10 }}>
            {events.length} events · newest first
          </span>
        </div>

        <div className="panel" style={{ padding: "4px 14px", overflow: "hidden" }}>
          {events.length === 0 && (
            <p className="meta" style={{ padding: "12px 0" }}>
              Nothing written yet.
            </p>
          )}
          {events.map((event) => (
            <div
              key={event.id}
              style={{
                display: "grid",
                gridTemplateColumns: "44px 64px 1fr auto auto",
                gap: 10,
                alignItems: "baseline",
                padding: "7px 0",
                borderBottom: "1px dotted var(--line)",
              }}
            >
              <span className="mono" style={{ fontSize: 10.5, color: "var(--ink-faint)" }}>
                #{event.seq}
              </span>
              <span className="label" style={{ fontSize: 9 }}>
                {event.kind}
              </span>
              <span className="mono" style={{ fontSize: 10.5, color: "var(--ink-dim)", overflow: "hidden" }}>
                {event.body.text
                  ? `“${event.body.text.slice(0, 54)}${event.body.text.length > 54 ? "…" : ""}”`
                  : event.body.name
                    ? `name → ${event.body.name}`
                    : event.body.target
                      ? `→ ${shortHash(event.body.target, 6, 4)}`
                      : ""}
              </span>
              <Copyable
                value={event.id}
                label={shortHash(event.id, 6, 4)}
                className="mono"
                title={`prev ${event.prev || "genesis"}`}
              />
              <span className="mono" style={{ fontSize: 10, color: "var(--water)" }} title="signature verified">
                ✓
              </span>
            </div>
          ))}
        </div>

        <p className="meta" style={{ marginTop: 16, lineHeight: 1.7 }}>
          Each event stores the id of the one before it. To change a sentence you would have to re-sign
          every event after it — with a key you do not have.
        </p>

        <p className="meta" style={{ marginTop: 10 }}>
          A post, an edit and a retraction are all just events here. Nothing is ever removed from this
          list.
        </p>

        <p className="meta" style={{ marginTop: 10 }}>
          Your key: {shortAddr(identity.publicKey)} ·{" "}
          <button
            className="link-quiet"
            style={{ textDecoration: "underline", fontSize: 11 }}
            onClick={() => onOpenProfile(identity.publicKey)}
          >
            open your profile
          </button>
        </p>
      </section>
    </>
  );
}
