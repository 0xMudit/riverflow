import { useState } from "react";
import type { Snapshot } from "@/core/types";
import { plural, shortAddr } from "../format";
import type { View } from "../App";
import type { PublishFn } from "../useNode";
import { Avatar } from "./Avatar";
import { Copyable } from "./Copy";

function Stat({ value, label }: { value: number | string; label: string }) {
  return (
    <div className="stat-cell">
      <div className="mono" style={{ fontSize: 15, color: "var(--ink)", lineHeight: 1.2 }}>
        {value}
      </div>
      <div className="label" style={{ fontSize: 9, marginTop: 3 }}>
        {label}
      </div>
    </div>
  );
}

export function RightRail({
  snapshot,
  onNavigate,
  publish,
  notify,
}: {
  snapshot: Snapshot;
  onNavigate: (view: View) => void;
  publish: PublishFn;
  notify: (message: string) => void;
}) {
  const me = snapshot.me;
  const [verifying, setVerifying] = useState(false);
  const following = new Set(snapshot.following);

  const suggestions = Object.values(snapshot.profiles)
    .filter((profile) => profile.pubkey !== me?.pubkey && !following.has(profile.pubkey))
    .slice(0, 4);

  const verify = async () => {
    setVerifying(true);
    try {
      const report = await window.river.verify();
      notify(
        report.ok
          ? `Verified ${plural(report.events, "event")} across ${plural(report.authors, "chain")} in ${report.durationMs}ms`
          : `Verification failed: ${report.errors[0]?.detail ?? "unknown error"}`,
      );
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "could not verify");
    } finally {
      setVerifying(false);
    }
  };

  const follow = async (pubkey: string) => {
    try {
      await publish("follow", { target: pubkey });
      notify("Following — written to your chain");
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "could not follow");
    }
  };

  const peers = snapshot.peers.length;

  return (
    <aside className="rail rail-right">
      <section className="panel" style={{ overflow: "hidden" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "11px 12px",
          }}
        >
          <span className="label">Your node</span>
          <span className="chip" style={{ borderColor: "transparent", background: "transparent" }}>
            <span
              style={{
                width: 5,
                height: 5,
                borderRadius: 99,
                background: peers > 0 ? "var(--water)" : "var(--silt)",
                boxShadow: peers > 0 ? "0 0 7px rgba(91,217,194,0.9)" : "none",
              }}
            />
            {peers > 0 ? "connected" : "alone"}
          </span>
        </div>

        <div className="stat-grid">
          <Stat value={peers} label={peers === 1 ? "peer" : "peers"} />
          <Stat value={(me?.seq ?? -1) + 1} label="your chain" />
          <Stat value={snapshot.stats.events} label="events" />
          <Stat value={snapshot.stats.authors} label="identities" />
        </div>

        <div style={{ padding: "10px 12px 12px" }}>
          <div className="label" style={{ fontSize: 9, marginBottom: 6 }}>
            your address
          </div>
          {snapshot.listen ? (
            <Copyable
              value={snapshot.listen}
              label={snapshot.listen}
              className="mono"
              title="Share this with someone on your network, or add theirs"
            />
          ) : (
            <span className="meta">not listening</span>
          )}

          <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
            <button className="btn" style={{ flex: 1, fontSize: 12 }} onClick={() => void verify()} disabled={verifying}>
              {verifying ? "checking…" : "Verify"}
            </button>
            <button
              className="btn"
              style={{ flex: 1, fontSize: 12 }}
              onClick={() => onNavigate({ name: "network" })}
            >
              Network
            </button>
          </div>
        </div>
      </section>

      {suggestions.length > 0 && (
        <section style={{ marginTop: 26 }}>
          <div className="label" style={{ marginBottom: 10 }}>
            Currents
          </div>
          <div style={{ display: "grid", gap: 11 }}>
            {suggestions.map((profile) => (
              <div key={profile.pubkey} style={{ display: "flex", gap: 9, alignItems: "center" }}>
                <Avatar name={profile.name} hue={profile.hue} size={26} title={profile.pubkey} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div
                    className="name"
                    style={{ fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis" }}
                  >
                    {profile.name}
                  </div>
                  <div className="meta" style={{ fontSize: 10 }}>
                    {shortAddr(profile.pubkey)}
                  </div>
                </div>
                <button
                  className="btn btn-ghost"
                  style={{ fontSize: 11, padding: "3px 6px" }}
                  onClick={() => void follow(profile.pubkey)}
                >
                  follow
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      <section style={{ marginTop: 26 }}>
        <div className="label" style={{ marginBottom: 8 }}>
          What this is
        </div>
        <p className="serif" style={{ fontSize: 12.5, lineHeight: 1.65, color: "var(--ink-dim)" }}>
          Every post is a signed event appended to your own chain. Nothing is ever removed — a
          retraction is itself an event, laid on top of the words it hides.
        </p>
        <p className="meta" style={{ marginTop: 10, lineHeight: 1.6 }}>
          Your key never leaves this machine. There is no server to shut down.
        </p>
      </section>
    </aside>
  );
}
