"use client";

import Link from "next/link";
import { useState } from "react";
import { Composer } from "@/components/Composer";
import { PostCard } from "@/components/PostCard";
import { Shell } from "@/components/Shell";
import { Toast } from "@/components/Toast";
import { plural } from "@/lib/format";
import { profileOf, threadOf, topLevelPosts, type Post } from "@/lib/river/project";
import { useRiver } from "@/lib/useRiver";
import { useToast } from "@/lib/useToast";

export default function RiverPage() {
  const { data, identity, error, submit, refresh } = useRiver();
  const { message, notify } = useToast();
  const [showSilt, setShowSilt] = useState(false);

  const state = data?.state ?? null;

  // Every write goes through here so the toast can name the block it landed in.
  const sealed = async (kind: Parameters<typeof submit>[0], body: Parameters<typeof submit>[1]) => {
    const block = await submit(kind, body);
    notify(`Sealed in block #${block.index}`);
    return block;
  };

  const posts: Post[] = state ? topLevelPosts(state).reverse() : [];
  const visible = posts.filter((post) => showSilt || !post.retracted);
  const siltCount = posts.filter((post) => post.retracted).length;

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
        <header
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
            gap: 16,
            padding: "20px 0 0",
          }}
        >
          <div>
            <h1 className="serif" style={{ fontSize: 23, lineHeight: 1.1, letterSpacing: "-0.01em" }}>
              The river
            </h1>
            <p className="meta" style={{ marginTop: 6 }}>
              {state
                ? `${plural(state.stats.posts, "post")} · ${plural(
                    state.stats.events,
                    "event",
                  )} · all of it permanent`
                : "opening the ledger…"}
            </p>
          </div>
          <button
            className="btn"
            onClick={() => setShowSilt((value) => !value)}
            style={
              showSilt
                ? {
                    color: "var(--silt)",
                    borderColor: "rgba(201,168,119,0.4)",
                    background: "var(--silt-wash)",
                  }
                : undefined
            }
            title="Retracted posts are hidden from the flow, never removed from the chain"
          >
            silt {siltCount > 0 ? siltCount : ""}
          </button>
        </header>

        <div style={{ marginTop: 18 }}>
          <Composer state={state} me={identity} submit={sealed} />
        </div>

        {error && (
          <div
            style={{
              marginTop: 14,
              display: "flex",
              alignItems: "center",
              gap: 10,
              fontSize: 12,
              color: "var(--danger)",
            }}
          >
            <span>{error}</span>
            <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => void refresh()}>
              retry
            </button>
          </div>
        )}

        <div style={{ marginTop: 24, borderTop: "1px solid var(--line)" }}>
          {!state &&
            Array.from({ length: 3 }).map((_, index) => (
              <div key={index} style={{ padding: "18px 20px", borderBottom: "1px solid var(--line)" }}>
                <div style={{ display: "flex", gap: 10 }}>
                  <div className="skeleton" style={{ width: 32, height: 32, borderRadius: 99 }} />
                  <div style={{ flex: 1, display: "grid", gap: 8 }}>
                    <div className="skeleton" style={{ height: 10, width: "22%" }} />
                    <div className="skeleton" style={{ height: 12, width: "92%" }} />
                    <div className="skeleton" style={{ height: 12, width: "64%" }} />
                  </div>
                </div>
              </div>
            ))}

          {state && visible.length === 0 && (
            <div style={{ padding: "48px 20px", textAlign: "center" }}>
              <p className="serif" style={{ fontSize: 16, color: "var(--ink-dim)" }}>
                The river is quiet.
              </p>
              <p className="meta" style={{ marginTop: 6 }}>
                Drop the first stone — it stays.
              </p>
            </div>
          )}

          {state &&
            visible.map((post) => {
              const replies = threadOf(state, post.id)
                .slice(1)
                .filter((reply) => showSilt || !reply.retracted);
              return (
                <div key={post.id}>
                  <PostCard
                    post={post}
                    state={state}
                    me={identity}
                    submit={sealed}
                    notify={notify}
                  />
                  {replies.length > 0 && (
                    <div style={{ background: "rgba(0,0,0,0.14)", paddingBottom: 4 }}>
                      {replies.map((reply) => {
                        const parent = reply.replyTo ? state.posts[reply.replyTo] : null;
                        return (
                          <PostCard
                            key={reply.id}
                            post={reply}
                            state={state}
                            me={identity}
                            submit={sealed}
                            notify={notify}
                            isReply
                            replyContext={
                              parent && parent.id !== post.id
                                ? { name: profileOf(state, parent.author).name }
                                : undefined
                            }
                          />
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
        </div>

        {state && (
          <p className="meta" style={{ marginTop: 22, lineHeight: 1.7 }}>
            You are reading block{" "}
            <Link href="/chain" style={{ color: "var(--water)", textDecoration: "none" }}>
              #{state.stats.blocks - 1}
            </Link>{" "}
            · {plural(state.stats.events, "signed event")} · every signature checked in this browser.
          </p>
        )}
      </Shell>

      <Toast message={message} />
    </>
  );
}
