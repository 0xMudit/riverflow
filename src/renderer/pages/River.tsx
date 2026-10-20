import type { PostView, Snapshot } from "@/core/types";
import { Composer } from "../components/Composer";
import { PostCard } from "../components/PostCard";
import { plural, profileOf } from "../format";
import type { PublishFn } from "../useNode";

export function RiverPage({
  snapshot,
  me,
  includeSilt,
  onToggleSilt,
  publish,
  notify,
  onOpenProfile,
  onOpenNetwork,
}: {
  snapshot: Snapshot;
  me: string;
  includeSilt: boolean;
  onToggleSilt: () => void;
  publish: PublishFn;
  notify: (message: string) => void;
  onOpenProfile: (pubkey: string) => void;
  onOpenNetwork: () => void;
}) {
  const iAmNamed = Boolean(snapshot.profiles[me]);

  const repliesByRoot = new Map<string, PostView[]>();
  for (const reply of snapshot.replies) {
    if (!reply.root) continue;
    const list = repliesByRoot.get(reply.root) ?? [];
    list.push(reply);
    repliesByRoot.set(reply.root, list);
  }

  const siltCount = snapshot.stats.retracted;

  return (
    <>
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
            {plural(snapshot.stats.posts, "post")} · {plural(snapshot.stats.events, "event")} · all of it
            permanent
          </p>
        </div>
        <button
          className="btn"
          onClick={onToggleSilt}
          style={
            includeSilt
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

      {!iAmNamed && (
        <div
          className="panel"
          style={{ marginTop: 16, padding: "12px 14px", borderColor: "rgba(91,217,194,0.24)" }}
        >
          <p className="serif" style={{ fontSize: 13.5, lineHeight: 1.6, color: "var(--ink-dim)" }}>
            Your node is running. This river is yours alone until someone connects — claim a name on the
            left, then add a peer under <strong style={{ color: "var(--ink)" }}>The network</strong>.
          </p>
          <button className="btn btn-ghost" style={{ fontSize: 11.5, marginTop: 6, paddingLeft: 0 }} onClick={onOpenNetwork}>
            open the network →
          </button>
        </div>
      )}

      <div style={{ marginTop: 18 }}>
        <Composer
          me={{ pubkey: me, name: snapshot.profiles[me]?.name ?? "you", hue: snapshot.profiles[me]?.hue ?? 200 }}
          chainSeq={snapshot.me?.seq ?? 0}
          publish={publish}
        />
      </div>

      <div style={{ marginTop: 24, borderTop: "1px solid var(--line)" }}>
        {snapshot.posts.length === 0 && (
          <div style={{ padding: "46px 20px", textAlign: "center" }}>
            <p className="serif" style={{ fontSize: 16, color: "var(--ink-dim)" }}>
              The river is quiet.
            </p>
            <p className="meta" style={{ marginTop: 6 }}>
              Drop the first stone — it stays.
            </p>
          </div>
        )}

        {snapshot.posts.map((post) => {
          const replies = (repliesByRoot.get(post.id) ?? []).filter(
            (reply) => includeSilt || !reply.retracted,
          );
          return (
            <div key={post.id}>
              <PostCard
                post={post}
                profiles={snapshot.profiles}
                me={me}
                publish={publish}
                notify={notify}
                onOpenProfile={onOpenProfile}
              />
              {replies.length > 0 && (
                <div style={{ background: "rgba(0,0,0,0.14)", paddingBottom: 4 }}>
                  {replies.map((reply) => {
                    const parent = reply.replyTo ? snapshot.profiles[reply.replyTo] : null;
                    return (
                      <PostCard
                        key={reply.id}
                        post={reply}
                        profiles={snapshot.profiles}
                        me={me}
                        publish={publish}
                        notify={notify}
                        onOpenProfile={onOpenProfile}
                        isReply
                        replyContext={
                          reply.replyTo && reply.replyTo !== post.id && parent
                            ? { name: parent.name }
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

      <p className="meta" style={{ marginTop: 22, lineHeight: 1.7 }}>
        Your chain is at seq {snapshot.me?.seq ?? -1} · {plural(snapshot.stats.events, "signed event")} in
        total · {snapshot.peers.length === 0 ? "no peers connected" : `${plural(snapshot.peers.length, "peer")} connected`}.
      </p>
    </>
  );
}
