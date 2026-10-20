"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Avatar } from "@/components/Avatar";
import { shortAddr } from "@/lib/format";
import { exportIdentity, forgetIdentity, importIdentity, type Identity } from "@/lib/river/identity";
import { profileOf, type RiverState } from "@/lib/river/project";
import type { EventBody } from "@/lib/river/types";

export function LeftRail({
  state,
  identity,
  submit,
  notify,
}: {
  state: RiverState | null;
  identity: Identity | null;
  submit: (kind: "profile", body: EventBody) => Promise<unknown>;
  notify: (message: string) => void;
}) {
  const pathname = usePathname();
  const profile = identity && state ? profileOf(state, identity.publicKey) : null;
  const hasProfile = Boolean(identity && state?.profiles[identity.publicKey]);
  const fileInput = useRef<HTMLInputElement>(null);

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [bio, setBio] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (profile) {
      setName((current) => current || profile.name);
      setBio((current) => current || profile.bio);
    }
  }, [profile]);

  const saveProfile = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await submit("profile", { name: name.trim().slice(0, 32), bio: bio.trim().slice(0, 160) });
      setEditing(false);
      notify("Name written to the ledger");
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "could not write profile");
    } finally {
      setBusy(false);
    }
  };

  const backup = () => {
    if (!identity) return;
    const blob = new Blob([exportIdentity(identity)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `river-key-${identity.publicKey.slice(0, 8)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    notify("Key file downloaded — there is no reset without it");
  };

  const restore = async (file: File) => {
    try {
      await importIdentity(await file.text());
      setEditing(false);
      setName("");
      setBio("");
      notify("Identity restored");
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "could not read that key");
    }
  };

  return (
    <aside className="rail rail-left" style={{ display: "flex", flexDirection: "column" }}>
      <Link href="/" className="wordmark-block">
        <div className="wordmark">
          River<em>.</em>
        </div>
        <div className="label" style={{ marginTop: 9, fontSize: 9, letterSpacing: "0.16em" }}>
          a ledger that forgets nothing
        </div>
      </Link>

      <nav style={{ marginTop: 30, display: "grid", gap: 2 }}>
        <Link className="nav-item" data-active={pathname === "/"} href="/">
          <span className="nav-dot" />
          The river
        </Link>
        <Link className="nav-item" data-active={pathname === "/chain"} href="/chain">
          <span className="nav-dot" />
          The ledger
        </Link>
        <a className="nav-item" href="https://github.com/0xMudit/MLE" target="_blank" rel="noreferrer">
          <span className="nav-dot" />
          Source
        </a>
      </nav>

      <div className="rail-hide-mobile" style={{ marginTop: "auto", paddingTop: 32 }}>
        <div className="label" style={{ marginBottom: 10 }}>
          You
        </div>

        {identity ? (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
              <Avatar
                name={profile?.name ?? `anon:${identity.publicKey.slice(0, 6)}`}
                hue={profile?.hue ?? 200}
                size={30}
                title={identity.publicKey}
              />
              <div style={{ minWidth: 0 }}>
                <div className="name" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                  {profile?.name ?? "unnamed"}
                </div>
                <div className="meta" style={{ marginTop: 2 }}>
                  {shortAddr(identity.publicKey)}
                </div>
              </div>
            </div>

            {!hasProfile && !editing && (
              <button
                className="btn"
                style={{ marginTop: 12, width: "100%" }}
                onClick={() => setEditing(true)}
              >
                Claim a name
              </button>
            )}

            {hasProfile && !editing && (
              <button
                className="btn-ghost btn"
                style={{ marginTop: 8, paddingLeft: 0, fontSize: 12 }}
                onClick={() => setEditing(true)}
              >
                Edit profile
              </button>
            )}

            {editing && (
              <div style={{ marginTop: 12, display: "grid", gap: 7 }}>
                <input
                  className="input"
                  placeholder="name"
                  value={name}
                  maxLength={32}
                  onChange={(event) => setName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void saveProfile();
                  }}
                  autoFocus
                />
                <input
                  className="input"
                  placeholder="bio (optional)"
                  value={bio}
                  maxLength={160}
                  onChange={(event) => setBio(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void saveProfile();
                  }}
                />
                <div style={{ display: "flex", gap: 6 }}>
                  <button className="btn btn-primary" disabled={busy} onClick={() => void saveProfile()}>
                    {busy ? "signing…" : "Seal"}
                  </button>
                  <button className="btn" onClick={() => setEditing(false)}>
                    Cancel
                  </button>
                </div>
                <p className="meta" style={{ lineHeight: 1.5, marginTop: 2 }}>
                  Profile changes are events too. Old names stay on the chain.
                </p>
              </div>
            )}

            <div style={{ display: "flex", gap: 4, marginTop: 14, flexWrap: "wrap" }}>
              <button className="btn btn-ghost" onClick={backup} title="Download your private key">
                back up key
              </button>
              <button
                className="btn btn-ghost"
                onClick={() => fileInput.current?.click()}
                title="Load a key file"
              >
                restore
              </button>
              <button
                className="btn btn-ghost"
                onClick={() => {
                  if (
                    window.confirm(
                      "Forgetting this key removes it from this browser only. Its posts stay on the chain forever, and no one can speak as it again. Continue?",
                    )
                  ) {
                    forgetIdentity();
                  }
                }}
                title="Remove the key from this browser"
              >
                forget
              </button>
            </div>
            <input
              ref={fileInput}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void restore(file);
                event.target.value = "";
              }}
            />
          </>
        ) : (
          <div className="skeleton" style={{ height: 30 }} />
        )}

        <div style={{ marginTop: 22, display: "flex", alignItems: "center", gap: 6 }}>
          <span
            style={{
              width: 5,
              height: 5,
              borderRadius: 99,
              background: state ? "var(--water)" : "var(--ink-faint)",
              boxShadow: state ? "0 0 7px rgba(91,217,194,0.8)" : "none",
            }}
          />
          <span className="meta">
            {state ? `block #${state.stats.blocks - 1}` : "connecting…"}
          </span>
        </div>
      </div>
    </aside>
  );
}
