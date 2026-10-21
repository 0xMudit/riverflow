import { useState } from "react";
import type { Event, PostView, ProfileView } from "@/core/types";
import { profileOf, shortAddr, shortHash, timeAgo } from "../format";
import type { PublishFn } from "../useNode";
import { Avatar } from "./Avatar";
import { Composer } from "./Composer";
import { Copyable } from "./Copy";

const KIND_LABEL: Record<string, string> = {
  post: "written",
  edit: "edited",
  retract: "retracted",
  reaction: "rippled",
};

function TrailRow({ event }: { event: Event }) {
  return (
    <div className="trail-row">
      <span className="label" style={{ fontSize: 9 }}>
        {KIND_LABEL[event.kind] ?? event.kind}
      </span>
      <span className="mono" style={{ color: "var(--ink-dim)", overflow: "hidden" }}>
        <span style={{ color: "var(--ink-faint)" }}>#{event.seq}</span>{" "}
        <Copyable
          value={event.id}
          label={shortHash(event.id, 8, 6)}
          className="mono"
          title={`event ${event.id}`}
        />
        {event.kind === "retract" && event.body.reason ? (
          <span style={{ color: "var(--silt)" }}> — “{event.body.reason}”</span>
        ) : null}
        {event.kind === "edit" ? (
          <span style={{ color: "var(--ink-faint)" }}>
            {" "}
            → “{(event.body.text ?? "").slice(0, 36)}
            {(event.body.text ?? "").length > 36 ? "…" : ""}”
          </span>
        ) : null}
      </span>
      <span className="mono" style={{ color: "var(--water)", fontSize: 10.5 }} title="signature verified on ingest">
        ✓
      </span>
    </div>
  );
}

export function PostCard({
  post,
  profiles,
  me,
  publish,
  notify,
  isReply = false,
  replyContext,
  onOpenProfile,
}: {
  post: PostView;
  profiles: Record<string, ProfileView>;
  me: string;
  publish: PublishFn;
  notify: (message: string) => void;
  isReply?: boolean;
  replyContext?: { name: string };
  onOpenProfile: (pubkey: string) => void;
}) {
  const author = profileOf(profiles, post.author);
  const isMine = me === post.author;

  const [showTrail, setShowTrail] = useState(false);
  const [trail, setTrail] = useState<Event[] | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [replying, setReplying] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(post.text);
  const [busy, setBusy] = useState(false);

  const blocked = post.retracted;

  const openTrail = async () => {
    const next = !showTrail;
    setShowTrail(next);
    if (next && trail === null) {
      try {
        setTrail(await window.river.trail(post.id));
      } catch {
        setTrail([]);
      }
    }
  };

  const react = async () => {
    try {
      await publish("reaction", { target: post.id, emoji: post.viewerReacted ? "" : "≈" });
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "could not react");
    }
  };

  const saveEdit = async () => {
    const next = draft.trim();
    if (!next || next === post.text) {
      setEditing(false);
      return;
    }
    setBusy(true);
    try {
      await publish("edit", { target: post.id, text: next });
      setEditing(false);
      notify("Edit sealed — the old text stays on your chain");
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "could not edit");
    } finally {
      setBusy(false);
    }
  };

  const retract = async () => {
    const confirmed = window.confirm(
      "Retract this post?\n\nIt will disappear from the river, but it is not deleted. The words stay on your chain forever, and this retraction becomes an event of its own.",
    );
    if (!confirmed) return;
    setBusy(true);
    try {
      await publish("retract", { target: post.id, reason: "retracted by author" });
      notify("Retracted — the words remain on the chain");
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "could not retract");
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className={`post ${blocked ? "post-silt" : ""} ${isReply ? "post-reply" : ""}`}>
      <header style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
        <button onClick={() => onOpenProfile(post.author)} aria-label={`Open ${author.name}`}>
          <Avatar name={author.name} hue={author.hue} size={isReply ? 26 : 32} title={post.author} />
        </button>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
            <button
              className="name"
              onClick={() => onOpenProfile(post.author)}
              style={{ textAlign: "left" }}
            >
              {author.name}
            </button>
            {isReply && replyContext && (
              <span className="meta" style={{ fontSize: 10 }}>
                ↳ {replyContext.name}
              </span>
            )}
            {blocked && <span className="chip chip-silt">retracted</span>}
            <span
              className="meta"
              style={{ marginLeft: "auto" }}
              title={new Date(post.createdAt).toLocaleString()}
            >
              {timeAgo(post.createdAt)}
            </span>
          </div>

          <div className="meta" style={{ marginTop: 3, display: "flex", gap: 8, alignItems: "center" }}>
            <span>{shortAddr(post.author)}</span>
            <span style={{ opacity: 0.4 }}>·</span>
            <span title={`event ${post.seq} in ${author.name}'s chain`}>seq {post.seq}</span>
            {post.device && (
              <>
                <span style={{ opacity: 0.4 }}>·</span>
                <span title={`written by the device ${post.device}`}>device {shortAddr(post.device)}</span>
              </>
            )}
          </div>

          {editing ? (
            <div style={{ marginTop: 10 }}>
              <textarea
                className="textarea"
                rows={4}
                value={draft}
                maxLength={2000}
                onChange={(event) => setDraft(event.target.value)}
                autoFocus
              />
              <div style={{ display: "flex", gap: 6, marginTop: 8, alignItems: "center" }}>
                <button className="btn btn-primary" disabled={busy} onClick={() => void saveEdit()}>
                  {busy ? "sealing…" : "Seal edit"}
                </button>
                <button
                  className="btn"
                  onClick={() => {
                    setEditing(false);
                    setDraft(post.text);
                  }}
                >
                  Cancel
                </button>
                <span className="meta" style={{ marginLeft: "auto" }}>
                  old text stays
                </span>
              </div>
            </div>
          ) : blocked ? (
            <div style={{ marginTop: 9 }}>
              {revealed ? (
                <p className="post-text post-text-silt">{post.text}</p>
              ) : (
                <p className="serif" style={{ fontSize: 13.5, color: "var(--ink-faint)", lineHeight: 1.55 }}>
                  This post was retracted by its author. Nothing was erased.
                </p>
              )}
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
                <button
                  className="btn btn-ghost"
                  style={{ fontSize: 11 }}
                  onClick={() => setRevealed((value) => !value)}
                >
                  {revealed ? "hide the silt" : "reveal the original"}
                </button>
                <span className="meta" style={{ fontSize: 10 }}>
                  silt in this chain
                </span>
              </div>
            </div>
          ) : (
            <>
              <p className="post-text" style={{ marginTop: 7 }}>
                {post.text}
              </p>
              {post.media && post.media.length > 0 && (
                <div className="post-media">
                  {post.media.map((item) => (
                    <img
                      key={item.hash}
                      src={`river://blob/${item.hash}`}
                      alt=""
                      loading="lazy"
                      style={
                        item.width && item.height
                          ? { aspectRatio: `${item.width} / ${item.height}` }
                          : undefined
                      }
                    />
                  ))}
                </div>
              )}
            </>
          )}

          <footer
            style={{
              display: "flex",
              alignItems: "center",
              gap: 2,
              marginTop: 9,
              marginLeft: -6,
              flexWrap: "wrap",
            }}
          >
            {!blocked && (
              <>
                <button
                  className="btn btn-ghost"
                  style={{ fontSize: 11.5, color: post.viewerReacted ? "var(--water)" : undefined }}
                  onClick={() => void react()}
                  title={post.viewerReacted ? "Withdraw your ripple (it stays on your chain)" : "Leave a ripple"}
                >
                  ≈ {post.reactions > 0 ? post.reactions : ""}
                </button>
                <button className="btn btn-ghost" style={{ fontSize: 11.5 }} onClick={() => setReplying((v) => !v)}>
                  reply{post.replyCount > 0 ? ` ${post.replyCount}` : ""}
                </button>
              </>
            )}

            <button className="btn btn-ghost" style={{ fontSize: 11.5 }} onClick={() => void openTrail()}>
              trail
            </button>

            {isMine && !blocked && (
              <>
                <button className="btn btn-ghost" style={{ fontSize: 11.5 }} onClick={() => setEditing(true)}>
                  edit
                </button>
                <button
                  className="btn btn-ghost"
                  style={{ fontSize: 11.5, color: "var(--silt)" }}
                  onClick={() => void retract()}
                  title="Hide this post; the text stays on your chain"
                >
                  retract
                </button>
              </>
            )}

            <span className="mono" style={{ marginLeft: "auto", fontSize: 10, color: "var(--ink-faint)" }}>
              ✓ signed
            </span>
          </footer>

          {replying && !blocked && (
            <div style={{ marginTop: 10 }}>
              <Composer
                me={
                  me
                    ? { pubkey: me, name: profileOf(profiles, me).name, hue: profileOf(profiles, me).hue }
                    : null
                }
                publish={publish}
                compact
                autoFocus
                replyTo={{ id: post.id, name: author.name }}
                onCancelReply={() => setReplying(false)}
              />
            </div>
          )}

          {showTrail && (
            <div
              style={{
                marginTop: 12,
                border: "1px solid var(--line)",
                borderRadius: 8,
                background: "rgba(0,0,0,0.22)",
                padding: "4px 12px 6px",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0" }}>
                <span className="label" style={{ fontSize: 9 }}>
                  Provenance
                </span>
                <span className="meta" style={{ fontSize: 10 }}>
                  {trail ? `${trail.length} event${trail.length === 1 ? "" : "s"}` : "reading…"} · immutable
                </span>
              </div>
              {(trail ?? []).map((event) => (
                <TrailRow key={event.id} event={event} />
              ))}
              <div className="meta" style={{ fontSize: 10, padding: "6px 0 8px", lineHeight: 1.5 }}>
                Every line above is a signature. None of it can be withdrawn.
              </div>
            </div>
          )}
        </div>
      </header>
    </article>
  );
}
