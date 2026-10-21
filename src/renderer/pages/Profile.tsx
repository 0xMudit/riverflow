import { useEffect, useState } from "react";
import { ArrowLeft, UserCheck, UserPlus } from "lucide-react";
import type { AuthorBundle } from "@/core/bridge";
import type { Snapshot } from "@/core/types";
import { Avatar } from "../components/Avatar";
import { Copyable } from "../components/Copy";
import { PostCard } from "../components/PostCard";
import { plural, profileOf, shortAddr } from "../format";
import type { PublishFn } from "../useNode";
import { Button } from "@/ui/button";
import { Skeleton } from "@/ui/skeleton";

export function ProfilePage({
  pubkey,
  snapshot,
  me,
  publish,
  notify,
  onBack,
  onOpenProfile,
}: {
  pubkey: string;
  snapshot: Snapshot;
  me: string;
  publish: PublishFn;
  notify: (message: string) => void;
  onBack: () => void;
  onOpenProfile: (pubkey: string) => void;
}) {
  const [bundle, setBundle] = useState<AuthorBundle | null>(null);
  const isMe = pubkey === me;
  const iFollow = snapshot.following.includes(pubkey);

  useEffect(() => {
    let alive = true;
    setBundle(null);
    void window.river
      .author(pubkey)
      .then((next) => alive && setBundle(next))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [pubkey, snapshot.me?.seq]);

  const profile = profileOf(
    { ...snapshot.profiles, ...(bundle?.profile ? { [bundle.profile.pubkey]: bundle.profile } : {}) },
    pubkey,
  );
  const named = Boolean(bundle?.profile);
  const posts = bundle?.posts ?? [];
  const profiles = {
    ...snapshot.profiles,
    ...(bundle?.profile ? { [bundle.profile.pubkey]: bundle.profile } : {}),
  };

  const toggleFollow = async () => {
    try {
      await publish("follow", { target: pubkey, unfollow: iFollow });
      notify(iFollow ? "Unfollowed — the follow stays on your chain" : "Following");
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "could not change follow");
    }
  };

  return (
    <>
      <header className="border-b border-border/60 px-4 py-4">
        <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2 mb-3 gap-1.5">
          <ArrowLeft className="size-4" />
          Back
        </Button>

        <div className="flex items-start gap-4">
          <Avatar
            name={named ? profile.name : `anon:${pubkey.slice(0, 6)}`}
            hue={profile.hue}
            size="xl"
            title={pubkey}
          />
          <div className="min-w-0 flex-1">
            <h1 className="font-serif text-[22px] leading-tight tracking-tight">
              {named ? profile.name : "unnamed key"}
            </h1>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <Copyable
                value={pubkey}
                label={shortAddr(pubkey)}
                className="mono text-xs text-muted-foreground"
                title="copy public key"
              />
              {named && <span className="text-xs text-muted-foreground">named</span>}
            </div>
            {named && profile.bio ? (
              <p className="mt-2 font-serif text-[14px] leading-relaxed text-muted-foreground">
                {profile.bio}
              </p>
            ) : null}
          </div>

          {!isMe && (
            <Button
              variant={iFollow ? "outline" : "default"}
              size="sm"
              className="rounded-full"
              onClick={() => void toggleFollow()}
            >
              {iFollow ? <UserCheck className="size-4" /> : <UserPlus className="size-4" />}
              {iFollow ? "Following" : "Follow"}
            </Button>
          )}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-5 text-xs text-muted-foreground">
          <span className="text-foreground">
            <span className="font-semibold">{posts.length}</span> {plural(posts.length, "post")}
          </span>
          {isMe && (
            <span>
              <span className="font-semibold text-foreground">{snapshot.followers.length}</span>{" "}
              {plural(snapshot.followers.length, "follower")}
            </span>
          )}
          <span>
            <span className="font-semibold text-foreground">
              {isMe ? snapshot.following.length : "—"}
            </span>{" "}
            following
          </span>
        </div>

        {!named && bundle && (
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            This key has never named itself. Its events are on the chain regardless.
          </p>
        )}
      </header>

      <div>
        {bundle === null && (
          <div className="space-y-3 px-4 py-6">
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        )}

        {bundle && posts.length === 0 && (
          <p className="px-4 py-12 text-center font-serif text-muted-foreground">
            {named ? "This identity has only ever listened." : "Nothing written under this key yet."}
          </p>
        )}

        {posts.map((post) => (
          <div key={post.id} className="border-b border-border/50">
            <PostCard
              post={post}
              profiles={profiles}
              me={me}
              publish={publish}
              notify={notify}
              onOpenProfile={onOpenProfile}
            />
          </div>
        ))}
      </div>
    </>
  );
}
