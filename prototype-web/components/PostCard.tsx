"use client";

import Link from "next/link";
import { useState } from "react";
import { Avatar } from "@/components/Avatar";
import { Composer } from "@/components/Composer";
import { Copyable } from "@/components/Copy";
import { shortAddr, shortHash, timeAgo } from "@/lib/format";
import { profileOf, type Post, type RiverState, type TrailEntry } from "@/lib/river/project";
import type { EventBody, EventKind } from "@/lib/river/types";

const KIND_LABEL: Record<string, string> = {
  post: "written",
  edit: "edited",
  retract: "retracted",
  reaction: "rippled",
};

function TrailRow({ entry }: { entry: TrailEntry }) {
  const event = entry.event;
  return (
    <div className="trail-row">
      <span className="label" style={{ fontSize: 9 }}>
        {KIND_LABEL[event.kind] ?? event.kind}
      </span>
      <span className="mono" style={{ color: "var(--ink-dim)", overflow: "hidden" }}>
        <span style={{ color: "var(--ink-faint)" }}>#{entry.block}</span>{" "}
        <Copyable
          value={event.id}
          label={shortHash(event.id, 8, 6)}
          className="mono"
          title={`event ${event.id} · signed by ${shortAddr(event.author)}`}
        />
        {event.kind === "retract" && event.body.reason ? (
          <span style={{ color: "var(--silt)" }}> — “{event.body.reason}”</span>
        ) : null}
        {event.kind === "edit" ? (
          <span style={{ color: "var(--ink-faint)" }}> → “{(event.body.text ?? "").slice(0, 40)}
            {(event.body.text ?? "").length > 40 ? "…" : ""}”</span>
        ) : null}
      </span>
      <span
        className="mono"
        style={{ color: entry.verified ? "var(--water)" : "var(--danger)", fontSize: 10.5 }}
        title={entry.verified ? "signature verified in your browser" : "signature invalid"}
      >
        {entry.verified ? "✓" : "✗"}
      </span>
    </div>
  );
}

export function PostCard({
  post,
  state,
  me,
  submit,
  notify,
  isReply = false,
  replyContext,
}: {
  post: Post;
  state: RiverState;
  me: { publicKey: string } | null;
  submit: (kind: EventKind, body: EventBody) => Promise<{ index: number }>;
  notify: (message: string) => void;
  isReply?: boolean;
  replyContext?: { name: string };
}) {
  const author = profileOf(state, post.author);
  const isMine = me?.publicKey === post.author;
  const [showTrail, setShowTrail] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [replying, setReplying] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(post.text);
  const [busy, setBusy] = useState(false);

  const trail = state.trail[post.id] ?? [];
  const myReaction = me ? post.reactions[me.publicKey] : undefined;
  const reactionCount = Object.keys(post.reactions).length;
  const edits = post.versions.length - 1;
  const blocked = Boolean(post.retracted);

  const react = async () => {
    if (blocked) return;
    try {
      await submit("reaction", { target: post.id, emoji: myReaction ? "" : "≈" });
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "could not react");
    }
  };

  const saveEdit = async () => {
    const next = draft.trim();
    if (!next || next === post.text || busy) {
      setEditing(false);
      return;
    }
    setBusy(true);
    try {
      await submit("edit", { target: post.id, text: next });
      setEditing(false);
      notify("Edit sealed — the previous text stays on the chain");
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "could not edit");
    } finally {
      setBusy(false);
    }
  };

  const retract = async () => {
    const confirmed = window.confirm(
      "Retract this post?\n\nIts text will disappear from the river, but it is not deleted. The words stay on the chain forever, and this retraction becomes a block of its own.",
    );
    if (!confirmed) return;
    setBusy(true);
    try {
      await submit("retract", { target: post.id, reason: "retracted by author" });
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
        <Avatar name={author.name} hue={author.hue} size={isReply ? 26 : 32} title={post.author} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
            <Link href={`/u/${post.author}`} className="name" style={{ textDecoration: "none" }}>
              {author.name}
            </Link>
            {isReply && replyContext && (
              <span className="meta" style={{ fontSize: 10 }}>
                ↳ {replyContext.name}
              </span>
            )}
            {blocked && <span className="chip chip-silt">retracted</span>}
            <span className="meta" style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
              <span title={new Date(post.createdAt).toLocaleString()}>{timeAgo(post.createdAt)}</span>
            </span>
          </div>
          <div className="meta" style={{ marginTop: 3, display: "flex", gap: 8, alignItems: "center" }}>
            <span>{shortAddr(post.author)}</span>
            <span style={{ opacity: 0.4 }}>·</span>
            <span className="meta" title={`event ${post.id}`}>
              block #{post.block}
            </span>
          </div>

          {editing ? (
            <div style={{ marginTop: 10 }}>
              <textarea
                className="textarea"
                rows={4}
                value={draft}
                maxLength={1000}
                onChange={(event) => setDraft(event.target.value)}
                autoFocus
              />
              <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
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
                <span className="meta" style={{ alignSelf: "center", marginLeft: "auto" }}>
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
                <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => setRevealed((v) => !v)}>
                  {revealed ? "hide the silt" : "reveal the original"}
                </button>
                {post.retracted && (
                  <span className="meta" style={{ fontSize: 10 }}>
                    silt since block #{post.retracted.block}
                  </span>
                )}
              </div>
            </div>
          ) : (
            <p className="post-text" style={{ marginTop: 7 }}>
              {post.text}
            </p>
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
                  style={{ fontSize: 11.5, color: myReaction ? "var(--water)" : undefined }}
                  onClick={() => void react()}
                  title={myReaction ? "Withdraw your ripple (the ripple stays on the chain)" : "Leave a ripple"}
                >
                  ≈ {reactionCount > 0 ? reactionCount : ""}
                </button>
                <button
                  className="btn btn-ghost"
                  style={{ fontSize: 11.5 }}
                  onClick={() => setReplying((value) => !value)}
                >
                  reply{post.replies.length > 0 ? ` ${post.replies.length}` : ""}
                </button>
              </>
            )}

            <button
              className="btn btn-ghost"
              style={{ fontSize: 11.5 }}
              onClick={() => setShowTrail((value) => !value)}
              title="Show every event that touched this post"
            >
              trail{edits > 0 ? ` · ${edits} edit${edits > 1 ? "s" : ""}` : ""}
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
                  title="Hide this post; the text stays on the chain"
                >
                  retract
                </button>
              </>
            )}

            <span
              className="mono"
              style={{ marginLeft: "auto", fontSize: 10, color: post.verified ? "var(--ink-faint)" : "var(--danger)" }}
              title={post.verified ? "signature verified locally" : "invalid signature"}
            >
              {post.verified ? "✓ signed" : "✗ forged"}
            </span>
          </footer>

          {replying && !blocked && (
            <div style={{ marginTop: 10 }}>
              <Composer
                state={state}
                me={me}
                submit={submit}
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
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "6px 0",
                }}
              >
                <span className="label" style={{ fontSize: 9 }}>
                  Provenance
                </span>
                <span className="meta" style={{ fontSize: 10 }}>
                  {trail.length} event{trail.length === 1 ? "" : "s"} · immutable
                </span>
              </div>
              {trail.map((entry) => (
                <TrailRow key={`${entry.event.id}-${entry.seq}`} entry={entry} />
              ))}
              <div className="meta" style={{ fontSize: 10, padding: "6px 0 8px", lineHeight: 1.5 }}>
                Every line above is a signature inside a mined block. None of it can be withdrawn.
              </div>
            </div>
          )}
        </div>
      </header>
    </article>
  );
}
