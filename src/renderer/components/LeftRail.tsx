import { useState } from "react";
import type { IdentityInfo } from "@/core/bridge";
import type { Snapshot } from "@/core/types";
import { shortAddr } from "../format";
import { Avatar } from "./Avatar";
import type { View } from "../App";
import type { PublishFn } from "../useNode";

export function LeftRail({
  snapshot,
  identity,
  view,
  onNavigate,
  publish,
  notify,
  query,
  onSearch,
}: {
  snapshot: Snapshot;
  identity: IdentityInfo;
  view: View;
  onNavigate: (view: View) => void;
  publish: PublishFn;
  notify: (message: string) => void;
  query: string;
  onSearch: (query: string) => void;
}) {
  const me = snapshot.me;
  const named = Boolean(snapshot.profiles[me?.pubkey ?? ""]);

  const [restoring, setRestoring] = useState(false);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);

  const backup = async () => {
    try {
      const key = await window.river.exportKey();
      const payload = JSON.stringify(
        {
          app: "river",
          note: "This private key is the account. Anyone holding it can speak as you. There is no reset.",
          publicKey: identity.publicKey,
          privateKey: key,
          exportedAt: new Date().toISOString(),
        },
        null,
        2,
      );
      const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `river-key-${identity.publicKey.slice(0, 8)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      notify("Key file saved — without it, this identity cannot speak again");
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "could not export the key");
    }
  };

  const restore = async () => {
    if (!secret.trim()) return;
    setBusy(true);
    try {
      await window.river.importKey(secret.trim());
      notify("Key accepted — restarting");
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "that key was not accepted");
      setBusy(false);
    }
  };

  const peers = snapshot.peers.length;

  return (
    <aside className="rail rail-left" style={{ display: "flex", flexDirection: "column" }}>
      <button
        className="wordmark-block"
        onClick={() => onNavigate({ name: "river" })}
        style={{ textAlign: "left" }}
      >
        <div className="wordmark">
          River<em>.</em>
        </div>
        <div className="label" style={{ marginTop: 9, fontSize: 9, letterSpacing: "0.16em" }}>
          a ledger that forgets nothing
        </div>
      </button>

      <nav style={{ marginTop: 30, display: "grid", gap: 2 }}>
        <button
          className="nav-item"
          data-active={view.name === "river"}
          onClick={() => onNavigate({ name: "river" })}
        >
          <span className="nav-dot" />
          The river
        </button>
        <button
          className="nav-item"
          data-active={view.name === "network"}
          onClick={() => onNavigate({ name: "network" })}
        >
          <span className="nav-dot" />
          The network
        </button>
        <button
          className="nav-item"
          data-active={view.name === "you"}
          onClick={() => onNavigate({ name: "you" })}
        >
          <span className="nav-dot" />
          You
        </button>
      </nav>

      <div style={{ marginTop: 12 }}>
        <input
          className="input"
          placeholder="search what you keep"
          value={query}
          onChange={(event) => onSearch(event.target.value)}
          aria-label="Search posts"
        />
      </div>

      <div className="rail-hide-mobile" style={{ marginTop: "auto", paddingTop: 32 }}>
        <div className="label" style={{ marginBottom: 10 }}>
          You
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <Avatar name={me?.name ?? "you"} hue={me?.hue ?? 200} size={30} title={identity.publicKey} />
          <div style={{ minWidth: 0 }}>
            <div className="name" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
              {named ? me?.name : "unnamed"}
            </div>
            <div className="meta" style={{ marginTop: 2 }}>
              {shortAddr(identity.publicKey)}
            </div>
          </div>
        </div>

        {!named && (
          <button
            className="btn"
            style={{ marginTop: 12, width: "100%" }}
            onClick={() => onNavigate({ name: "you" })}
          >
            Claim a name
          </button>
        )}

        {named && (
          <button
            className="btn btn-ghost"
            style={{ marginTop: 8, paddingLeft: 0, fontSize: 12 }}
            onClick={() => onNavigate({ name: "you" })}
          >
            Edit profile
          </button>
        )}

        {restoring ? (
          <div style={{ marginTop: 12, display: "grid", gap: 7 }}>
            <textarea
              className="input mono"
              rows={3}
              placeholder="paste a 64-character private key"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              style={{ fontSize: 11, resize: "vertical" }}
            />
            <div style={{ display: "flex", gap: 6 }}>
              <button className="btn btn-danger" disabled={busy || !secret.trim()} onClick={() => void restore()}>
                {busy ? "restoring…" : "Restore & restart"}
              </button>
              <button className="btn" onClick={() => setRestoring(false)}>
                Cancel
              </button>
            </div>
            <p className="meta" style={{ lineHeight: 1.5 }}>
              This replaces the key on this machine. The old identity stays on the network.
            </p>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 4, marginTop: 14, flexWrap: "wrap" }}>
            <button className="btn btn-ghost" onClick={() => void backup()} title="Save your private key">
              back up key
            </button>
            <button className="btn btn-ghost" onClick={() => setRestoring(true)} title="Load a key">
              restore
            </button>
          </div>
        )}

        <div style={{ marginTop: 20, display: "flex", alignItems: "center", gap: 6 }}>
          <span
            style={{
              width: 5,
              height: 5,
              borderRadius: 99,
              background: peers > 0 ? "var(--water)" : "var(--ink-faint)",
              boxShadow: peers > 0 ? "0 0 7px rgba(91,217,194,0.8)" : "none",
            }}
          />
          <span className="meta">
            {peers === 0 ? "no peers yet" : `${peers} peer${peers === 1 ? "" : "s"} · seq ${me?.seq ?? -1}`}
          </span>
        </div>
      </div>
    </aside>
  );
}
