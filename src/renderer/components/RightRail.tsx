import { useState } from "react";
import { Radio, UserPlus } from "lucide-react";
import type { Snapshot } from "@/core/types";
import { plural, shortAddr } from "../format";
import type { View } from "../App";
import type { PublishFn } from "../useNode";
import { Avatar } from "./Avatar";
import { Copyable } from "./Copy";
import { Button } from "@/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/card";

export function RightRail({
  snapshot,
  onNavigate,
  publish,
  notify,
}: {
  snapshot: Snapshot;
  onNavigate: (view: View) => void;
  publish: PublishFn;
  notify: (message: string) => void;
}) {
  const me = snapshot.me;
  const [verifying, setVerifying] = useState(false);
  const following = new Set(snapshot.following);

  const suggestions = Object.values(snapshot.profiles)
    .filter((profile) => profile.pubkey !== me?.pubkey && !following.has(profile.pubkey))
    .slice(0, 3);

  const verify = async () => {
    setVerifying(true);
    try {
      const report = await window.river.verify();
      notify(
        report.ok
          ? `Verified ${plural(report.events, "event")} — every link and signature holds`
          : "Verification failed",
      );
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "could not verify");
    } finally {
      setVerifying(false);
    }
  };

  const follow = async (pubkey: string) => {
    try {
      await publish("follow", { target: pubkey });
      notify("Following — written to your chain");
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "could not follow");
    }
  };

  const peers = snapshot.peers.length;

  return (
    <aside className="sticky top-0 flex h-screen w-[320px] shrink-0 flex-col gap-4 overflow-y-auto px-2 py-4">
      <Card className="border-border/70 bg-card/50">
        <CardHeader className="px-4 py-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Radio className={peers > 0 ? "size-4 text-primary" : "size-4 text-muted-foreground"} />
            Your node
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          <p className="text-sm text-muted-foreground">
            {plural(snapshot.stats.events, "event")} · {plural(snapshot.stats.authors, "person", "people")} ·{" "}
            {peers === 0 ? "alone" : plural(peers, "peer")}
          </p>

          <div className="mt-3">
            <div className="label mb-1.5 text-[9px]">your address</div>
            {snapshot.listen ? (
              <Copyable
                value={snapshot.listen}
                label={snapshot.listen}
                className="mono text-xs text-muted-foreground"
                title="Share this with someone, or add theirs"
              />
            ) : (
              <span className="text-xs text-muted-foreground">not listening</span>
            )}
          </div>

          <div className="mt-4 flex gap-2">
            <Button size="sm" variant="outline" className="flex-1" disabled={verifying} onClick={() => void verify()}>
              {verifying ? "checking…" : "Verify"}
            </Button>
            <Button size="sm" className="flex-1" onClick={() => onNavigate({ name: "network" })}>
              Find people
            </Button>
          </div>
        </CardContent>
      </Card>

      {suggestions.length > 0 && (
        <Card className="border-border/70 bg-card/50">
          <CardHeader className="px-4 py-3">
            <CardTitle className="text-sm">Who to follow</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 px-4 pb-4">
            {suggestions.map((profile) => (
              <div key={profile.pubkey} className="flex items-center gap-2.5">
                <button onClick={() => onNavigate({ name: "profile", pubkey: profile.pubkey })}>
                  <Avatar name={profile.name} hue={profile.hue} size="sm" title={profile.pubkey} />
                </button>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{profile.name}</div>
                  <div className="truncate text-[11px] text-muted-foreground">{shortAddr(profile.pubkey)}</div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 rounded-full px-3 text-xs"
                  onClick={() => void follow(profile.pubkey)}
                >
                  <UserPlus className="size-3.5" />
                  Follow
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="px-3 pb-6">
        <div className="label mb-2 text-[9px]">What this is</div>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          Every post is a signed event in your own chain. Nothing is ever removed — a retraction is
          itself an event, laid on top of the words it hides.
        </p>
        <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
          Your key never leaves this machine. There is no server to shut down.
        </p>
      </div>
    </aside>
  );
}
