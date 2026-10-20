"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import { Avatar } from "@/components/Avatar";
import { Composer } from "@/components/Composer";
import { Copyable } from "@/components/Copy";
import { PostCard } from "@/components/PostCard";
import { Shell } from "@/components/Shell";
import { Toast } from "@/components/Toast";
import { plural, shortAddr } from "@/lib/format";
import { profileOf, type Post } from "@/lib/river/project";
import { useRiver } from "@/lib/useRiver";
import { useToast } from "@/lib/useToast";

export default function ProfilePage() {
  const params = useParams<{ pubkey: string }>();
  const pubkey = Array.isArray(params.pubkey) ? params.pubkey[0] : params.pubkey;
  const { data, identity, submit } = useRiver(8000);
  const { message, notify } = useToast();
  const [copied, setCopied] = useState(false);

  const state = data?.state ?? null;
  const profile = state && pubkey ? profileOf(state, pubkey) : null;
  const named = Boolean(state?.profiles[pubkey]);
  const me = identity?.publicKey === pubkey;

  const sealed = async (kind: Parameters<typeof submit>[0], body: Parameters<typeof submit>[1]) => {
    const block = await submit(kind, body);
    notify(`Sealed in block #${block.index}`);
    return block;
  };

  const posts: Post[] = state && pubkey
    ? state.postOrder
        .map((id) => state.posts[id])
        .filter((post) => post && post.author === pubkey)
        .reverse()
    : [];

  const following = state?.following[pubkey] ?? [];
  const followers = state?.followers[pubkey] ?? [];
  const iFollow = Boolean(identity && following.includes(identity.publicKey));

  return (
    <>
      <Shell
        state={state}
        report={data?.report ?? null}
        blocks={data?.blocks ?? []}
        identity={identity}
        submit={sealed}
        notify={notify}
      >
        <header style={{ padding: "22px 0 18px", borderBottom: "1px solid var(--line)" }}>
          <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
            <Avatar
              name={profile?.name ?? `anon:${(pubkey ?? "").slice(0, 6)}`}
              hue={profile?.hue ?? 200}
              size={54}
              title={pubkey}
            />
            <div style={{ minWidth: 0, flex: 1 }}>
              <h1 className="serif" style={{ fontSize: 22, lineHeight: 1.2, letterSpacing: "-0.01em" }}>
                {named ? profile?.name : "unnamed key"}
              </h1>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
                <Copyable
                  value={pubkey ?? ""}
                  label={shortAddr(pubkey ?? "")}
                  className="chip"
                  title="copy public key"
                />
                {named && profile?.block !== undefined && (
                  <span className="meta">named in block #{profile.block}</span>
                )}
              </div>
              {named && profile?.bio ? (
                <p className="serif" style={{ fontSize: 13.5, color: "var(--ink-dim)", marginTop: 9, lineHeight: 1.55 }}>
                  {profile.bio}
                </p>
              ) : null}
            </div>
          </div>

          <div style={{ display: "flex", gap: 18, marginTop: 14, flexWrap: "wrap", alignItems: "center" }}>
            <span className="meta">{plural(posts.length, "post")}</span>
            <span className="meta">{plural(followers.length, "follower")}</span>
            <span className="meta">following {following.length}</span>

            <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
              {!me && identity && (
                <button
                  className={iFollow ? "btn" : "btn btn-primary"}
                  onClick={async () => {
                    try {
                      await sealed("follow", { target: pubkey, unfollow: iFollow });
                    } catch {
                      /* the toast already carries the reason */
                    }
                  }}
                >
                  {iFollow ? "unfollow" : "follow"}
                </button>
              )}
              <button
                className="btn btn-ghost"
                onClick={async () => {
                  await navigator.clipboard.writeText(window.location.href);
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1200);
                }}
                title="copy a link to this profile"
              >
                {copied ? "copied" : "share"}
              </button>
            </div>
          </div>

          {!named && (
            <p className="meta" style={{ marginTop: 12, lineHeight: 1.6 }}>
              This key has never named itself. Its events are on the chain regardless.
            </p>
          )}
        </header>

        {me && (
          <div style={{ marginTop: 18 }}>
            <Composer state={state} me={identity} submit={sealed} />
          </div>
        )}

        <div style={{ marginTop: 20 }}>
          {posts.length === 0 && (
            <p className="serif" style={{ fontSize: 14, color: "var(--ink-faint)", padding: "28px 0" }}>
              This identity has only ever listened.
            </p>
          )}
          {posts.map((post) => {
            const parent = post.replyTo && state ? state.posts[post.replyTo] : null;
            return (
              <PostCard
                key={post.id}
                post={post}
                state={state!}
                me={identity}
                submit={sealed}
                notify={notify}
                replyContext={
                  parent ? { name: profileOf(state!, parent.author).name } : undefined
                }
              />
            );
          })}
        </div>
      </Shell>

      <Toast message={message} />
    </>
  );
}
