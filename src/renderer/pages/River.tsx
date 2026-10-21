import type { PostView, Snapshot } from "@/core/types";
import { Composer } from "../components/Composer";
import { PostCard } from "../components/PostCard";
import { plural } from "../format";
import type { PublishFn } from "../useNode";
import { Button } from "@/ui/button";

export function RiverPage({
  snapshot,
  me,
  includeSilt,
  onToggleSilt,
  publish,
  notify,
  onOpenProfile,
  onOpenNetwork,
  onOpenYou,
  writer,
  results,
  onClearSearch,
}: {
  snapshot: Snapshot;
  me: string;
  includeSilt: boolean;
  onToggleSilt: () => void;
  publish: PublishFn;
  notify: (message: string) => void;
  onOpenProfile: (pubkey: string) => void;
  onOpenNetwork: () => void;
  onOpenYou: () => void;
  /** the device key to write with; empty means the root key */
  writer: string;
  /** posts matching the search, or null when no search is running */
  results: PostView[] | null;
  onClearSearch: () => void;
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
      <header className="sticky top-0 z-10 flex items-end justify-between gap-4 border-b border-border/60 bg-background/90 px-4 py-3.5 backdrop-blur">
        <div>
          <h1 className="font-serif text-[22px] leading-none tracking-tight">The river</h1>
          <p className="mt-1.5 text-xs text-muted-foreground">
            {plural(snapshot.stats.posts, "post")} · {plural(snapshot.stats.events, "event")} · all of
            it permanent
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onToggleSilt}
          className={includeSilt ? "text-silt" : "text-muted-foreground"}
          title="Retracted posts are hidden from the flow, never removed from the chain"
        >
          Silt{siltCount > 0 ? ` ${siltCount}` : ""}
        </Button>
      </header>

      <div className="px-4 py-4">
        {!iAmNamed && (
          <div className="mb-4 rounded-2xl border border-primary/25 bg-primary/[0.04] p-5">
            <h2 className="font-serif text-[19px] leading-tight">This is your river.</h2>
            <p className="mt-2 font-serif text-[15px] leading-relaxed text-muted-foreground">
              No account, no server, no feed algorithm. Everything you write is signed by a key that
              lives on this machine, kept in your chain for good, and shared with anyone you point
              your node at.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button onClick={onOpenYou}>Choose a name</Button>
              <Button variant="outline" onClick={onOpenNetwork}>
                Find people
              </Button>
            </div>
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              It is quiet right now: nobody else is here. Share your address, or let the network
              introduce you.
            </p>
          </div>
        )}

        <Composer
          me={{ pubkey: me, name: snapshot.profiles[me]?.name ?? "you", hue: snapshot.profiles[me]?.hue ?? 200 }}
          chainSeq={snapshot.me?.seq ?? 0}
          publish={publish}
          device={writer}
        />
      </div>

      {results !== null ? (
        <div>
          <div className="flex items-center justify-between border-y border-border/60 px-4 py-2.5">
            <span className="label text-[9px]">search</span>
            <Button variant="ghost" size="sm" onClick={onClearSearch}>
              Back to the river
            </Button>
          </div>
          {results.length === 0 ? (
            <p className="px-4 py-12 text-center font-serif text-muted-foreground">
              Nothing you keep says that.
            </p>
          ) : (
            results.map((post) => (
              <div key={post.id} className="border-b border-border/50">
                <PostCard
                  post={post}
                  profiles={snapshot.profiles}
                  me={me}
                  publish={publish}
                  notify={notify}
                  onOpenProfile={onOpenProfile}
                />
              </div>
            ))
          )}
        </div>
      ) : (
        <div>
          {snapshot.posts.length === 0 && (
            <div className="px-4 py-16 text-center">
              <p className="font-serif text-lg text-muted-foreground">The river is quiet.</p>
              <p className="mt-1.5 text-xs text-muted-foreground">
                Drop the first stone — it stays.
              </p>
            </div>
          )}

          {snapshot.posts.map((post) => {
            const replies = (repliesByRoot.get(post.id) ?? []).filter(
              (reply) => includeSilt || !reply.retracted,
            );
            return (
              <div key={post.id} className="border-b border-border/50">
                <PostCard
                  post={post}
                  profiles={snapshot.profiles}
                  me={me}
                  publish={publish}
                  notify={notify}
                  onOpenProfile={onOpenProfile}
                />
                {replies.length > 0 && (
                  <div className="bg-background/40 pb-1">
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
      )}

      <p className="px-4 py-6 text-xs leading-relaxed text-muted-foreground">
        Your chain is at event {snapshot.me?.seq ?? -1} ·{" "}
        {plural(snapshot.stats.events, "signed event")} in total ·{" "}
        {snapshot.peers.length === 0
          ? "no peers connected"
          : `${plural(snapshot.peers.length, "peer")} connected`}.
      </p>
    </>
  );
}
