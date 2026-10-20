import { useEffect, useState } from "react";
import type { AuthorBundle } from "@/core/bridge";
import type { Snapshot } from "@/core/types";
import { Avatar } from "../components/Avatar";
import { Copyable } from "../components/Copy";
import { PostCard } from "../components/PostCard";
import { plural, profileOf, shortAddr } from "../format";
import type { PublishFn } from "../useNode";

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
      <header style={{ padding: "18px 0 18px", borderBottom: "1px solid var(--line)" }}>
        <button className="btn btn-ghost" style={{ fontSize: 11.5, marginBottom: 14 }} onClick={onBack}>
          ← back
        </button>

        <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
          <Avatar
            name={named ? profile.name : `anon:${pubkey.slice(0, 6)}`}
            hue={profile.hue}
            size={54}
            title={pubkey}
          />
          <div style={{ minWidth: 0, flex: 1 }}>
            <h1 className="serif" style={{ fontSize: 22, lineHeight: 1.2, letterSpacing: "-0.01em" }}>
              {named ? profile.name : "unnamed key"}
            </h1>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
              <Copyable value={pubkey} label={shortAddr(pubkey)} className="chip" title="copy public key" />
              {named && <span className="meta">named at seq {profile.seq}</span>}
            </div>
            {named && profile.bio ? (
              <p
                className="serif"
                style={{ fontSize: 13.5, color: "var(--ink-dim)", marginTop: 9, lineHeight: 1.55 }}
              >
                {profile.bio}
              </p>
            ) : null}
          </div>
        </div>

        <div style={{ display: "flex", gap: 18, marginTop: 14, flexWrap: "wrap", alignItems: "center" }}>
          <span className="meta">{plural(posts.length, "post")}</span>
          {isMe && <span className="meta">{plural(snapshot.followers.length, "follower")}</span>}
          <span className="meta">following {isMe ? snapshot.following.length : "—"}</span>

          {!isMe && (
            <button
              className={iFollow ? "btn" : "btn btn-primary"}
              style={{ marginLeft: "auto" }}
              onClick={() => void toggleFollow()}
            >
              {iFollow ? "unfollow" : "follow"}
            </button>
          )}
        </div>

        {!named && bundle && (
          <p className="meta" style={{ marginTop: 12, lineHeight: 1.6 }}>
            This key has never named itself. Its events are on the chain regardless.
          </p>
        )}
      </header>

      <div style={{ marginTop: 8 }}>
        {bundle === null && (
          <div style={{ padding: "20px 0", display: "grid", gap: 8 }}>
            <div className="skeleton" style={{ height: 12, width: "50%" }} />
            <div className="skeleton" style={{ height: 12, width: "80%" }} />
          </div>
        )}

        {bundle && posts.length === 0 && (
          <p className="serif" style={{ fontSize: 14, color: "var(--ink-faint)", padding: "30px 0" }}>
            {named ? "This identity has only ever listened." : "Nothing written under this key yet."}
          </p>
        )}

        {posts.map((post) => (
          <PostCard
            key={post.id}
            post={post}
            profiles={profiles}
            me={me}
            publish={publish}
            notify={notify}
            onOpenProfile={onOpenProfile}
          />
        ))}
      </div>
    </>
  );
}
