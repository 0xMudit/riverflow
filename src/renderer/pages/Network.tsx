import { useEffect, useState } from "react";
import { Link2, ShieldCheck, Trash2, PencilRuler } from "lucide-react";
import type { BreachReport, CheckpointView, IdentityInfo, NetworkStatus } from "@/core/bridge";
import type { Event, Snapshot, VerifyReport } from "@/core/types";
import { Copyable } from "../components/Copy";
import { plural, shortHash, timeAgo } from "../format";
import { Button } from "@/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/card";
import { Input } from "@/ui/input";

type Mode = "verify" | "erase" | "rewrite";

export function NetworkPage({
  snapshot,
  identity,
  notify,
  onOpenProfile,
}: {
  snapshot: Snapshot;
  identity: IdentityInfo;
  notify: (message: string) => void;
  onOpenProfile: (pubkey: string) => void;
}) {
  const [report, setReport] = useState<(VerifyReport & { removedSeq?: number | null }) | null>(null);
  const [mode, setMode] = useState<Mode | null>(null);
  const [busy, setBusy] = useState(false);
  const [events, setEvents] = useState<Event[]>([]);
  const [address, setAddress] = useState("");
  const [network, setNetwork] = useState<NetworkStatus | null>(null);
  const [checkpoints, setCheckpoints] = useState<CheckpointView[]>([]);

  const mySeq = snapshot.me?.seq ?? -1;

  useEffect(() => {
    let alive = true;
    const load = () => {
      void window.river
        .author(identity.publicKey)
        .then((bundle) => alive && setEvents(bundle.events))
        .catch(() => undefined);
      void window.river
        .network()
        .then((status) => alive && setNetwork(status))
        .catch(() => undefined);
      void window.river
        .checkpoints()
        .then((list) => alive && setCheckpoints(list))
        .catch(() => undefined);
    };
    load();
    const timer = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [identity.publicKey, mySeq]);

  const run = async (next: Mode) => {
    setBusy(true);
    setMode(next);
    try {
      if (next === "verify") {
        const result = await window.river.verify();
        setReport(result);
        notify(
          result.ok
            ? `Verified ${plural(result.events, "event")} — every link and signature holds`
            : "Verification failed",
        );
      } else {
        const result: BreachReport = await window.river.breach(next);
        setReport(result);
        notify(
          `Simulated ${next === "erase" ? "erasure" : "rewrite"} — the chain noticed`,
        );
      }
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "could not run that check");
    } finally {
      setBusy(false);
    }
  };

  const addPeer = async () => {
    const target = address.trim();
    if (!target) return;
    const result = await window.river.dial(target);
    if (result.ok) {
      setAddress("");
      notify(`Dialling ${target}`);
    } else {
      notify(result.error ?? "could not connect");
    }
  };

  const breached = mode === "erase" || mode === "rewrite";

  return (
    <>
      <header className="sticky top-0 z-10 border-b border-border/60 bg-background/90 px-4 py-3.5 backdrop-blur">
        <h1 className="font-serif text-[22px] leading-none tracking-tight">The network</h1>
        <p className="mt-1.5 text-xs text-muted-foreground">
          {plural(snapshot.peers.length, "peer")} · {plural(snapshot.stats.authors, "person", "people")} ·{" "}
          {plural(snapshot.stats.events, "event")}
        </p>
      </header>

      <div className="space-y-4 px-4 py-4">
        <Card className="border-border/70 bg-card/40">
          <CardHeader className="px-4 py-3">
            <CardTitle className="text-sm">People</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <div className="label mb-1.5 text-[9px]">your address</div>
            {snapshot.listen ? (
              <Copyable
                value={snapshot.listen}
                label={snapshot.listen}
                className="mono text-xs text-muted-foreground"
                title="Share this, or dial theirs"
              />
            ) : (
              <span className="text-xs text-muted-foreground">not listening</span>
            )}

            <div className="mt-3 flex gap-2">
              <Input
                value={address}
                onChange={(event) => setAddress(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void addPeer();
                }}
                placeholder="192.168.1.20:7331"
                className="mono h-9 text-xs"
              />
              <Button size="sm" onClick={() => void addPeer()}>
                Connect
              </Button>
            </div>

            <div className="mt-3">
              {snapshot.peers.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  Nobody else is here yet. People on the same network find you by themselves; across
                  networks the table below does it.
                </p>
              )}
              {snapshot.peers.map((peer) => (
                <div
                  key={peer.id}
                  className="flex items-baseline gap-2 border-t border-border/50 py-2 text-xs first:border-t-0"
                >
                  <button
                    className="mono truncate text-foreground hover:underline"
                    onClick={() => onOpenProfile(peer.id)}
                  >
                    {peer.id.slice(0, 12)}…
                  </button>
                  <span className="text-muted-foreground">
                    {peer.address} · {peer.direction}
                  </span>
                  <span className="ml-auto shrink-0 text-muted-foreground">{timeAgo(peer.since)}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="border-border/70 bg-card/40">
          <CardHeader className="px-4 py-3">
            <CardTitle className="text-sm">Reach</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">distributed table</dt>
              <dd>
                {network?.dht.active
                  ? "on the network"
                  : network?.dht.enabled
                    ? "starting…"
                    : "off"}
              </dd>

              <dt className="text-muted-foreground">peers it knows</dt>
              <dd>{network?.dht.peers ?? 0}</dd>

              <dt className="text-muted-foreground">bootstrap</dt>
              <dd className="mono truncate text-xs">
                {network?.dht.bootstrap.length ? network.dht.bootstrap.join(", ") : "public nodes"}
              </dd>

              <dt className="text-muted-foreground">relay</dt>
              <dd>{network?.relay ? "holding other people's logs" : "not holding"}</dd>

              <dt className="text-muted-foreground">subscribed to</dt>
              <dd>{network?.subscriptions.length ?? 0} people</dd>
            </dl>

            {network?.dht.error && <p className="mt-3 text-xs text-destructive">{network.dht.error}</p>}

            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              Peers find each other through a distributed table and punch a hole through both
              firewalls. The traffic is encrypted end to end, so the table never sees a post — and
              you can point this node at a table you run yourself.
            </p>
          </CardContent>
        </Card>

        <Card
          className={`border-border/70 bg-card/40 ${breached ? "border-destructive/40" : ""}`}
        >
          <CardHeader className="px-4 py-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <ShieldCheck className="size-4 text-primary" />
              Integrity
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <p className="text-sm font-medium">
              {!report
                ? "Not checked yet"
                : report.ok
                  ? "Every chain verifies"
                  : breached
                    ? "The chain broke immediately"
                    : "Verification failed"}
            </p>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              {breached
                ? `You ${mode === "erase" ? "removed one event" : "rewrote one event"}'s text in a copy held in memory. ${
                    mode === "erase"
                      ? "Every later event still points at the missing one, so the chain reports a gap at that exact position."
                      : "The edit kept its old id, so the signature no longer covers the content."
                  } The database on disk was never touched.`
                : "Each node re-hashes its own chains from the first event and checks every signature. Nothing is taken on faith, and no one has to be trusted with the check."}
            </p>

            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" disabled={busy} onClick={() => void run("verify")}>
                {busy && mode === "verify" ? "checking…" : "Verify everything"}
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void run("erase")}>
                <Trash2 className="size-4" />
                Try to erase an event
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void run("rewrite")}>
                <PencilRuler className="size-4" />
                Try to rewrite a post
              </Button>
            </div>

            {report && report.errors.length > 0 && (
              <ul className="mt-3 space-y-1 text-xs text-destructive">
                {report.errors.slice(0, 4).map((error, index) => (
                  <li key={index}>
                    <span className="mono">
                      seq {error.seq} · {error.code}
                    </span>{" "}
                    — {error.detail}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card className="border-border/70 bg-card/40">
          <CardHeader className="px-4 py-3">
            <CardTitle className="text-sm">Checkpoints</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            {checkpoints.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No checkpoint yet — one is signed every minute.
              </p>
            ) : (
              checkpoints.map((checkpoint) => (
                <div
                  key={checkpoint.root}
                  className="flex items-baseline gap-2 border-t border-border/50 py-2 text-xs first:border-t-0"
                >
                  <span className="mono truncate text-muted-foreground">
                    {checkpoint.root.slice(0, 16)}…
                  </span>
                  <span className="ml-auto shrink-0 text-muted-foreground">
                    {checkpoint.count} events · {timeAgo(checkpoint.at)}
                  </span>
                </div>
              ))
            )}
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              A Merkle root over your chain, signed by you. A node that missed part of your history
              can be handed the root and a short path and check the rest without replaying
              everything.
            </p>
          </CardContent>
        </Card>

        <Card className="border-border/70 bg-card/40">
          <CardHeader className="flex-row items-center justify-between px-4 py-3">
            <CardTitle className="text-sm">Your chain</CardTitle>
            <span className="text-[11px] text-muted-foreground">{events.length} events</span>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            {events.length === 0 ? (
              <p className="text-xs text-muted-foreground">Nothing written yet.</p>
            ) : (
              events.map((event) => (
                <div
                  key={event.id}
                  className="flex items-baseline gap-2 border-t border-border/50 py-1.5 text-xs first:border-t-0"
                >
                  <span className="mono w-6 shrink-0 text-muted-foreground">#{event.seq}</span>
                  <span className="label w-16 shrink-0 text-[9px]">{event.kind}</span>
                  <span className="mono min-w-0 flex-1 truncate text-muted-foreground">
                    {event.body.text
                      ? `“${event.body.text.slice(0, 54)}${event.body.text.length > 54 ? "…" : ""}”`
                      : event.body.name
                        ? `name → ${event.body.name}`
                        : event.body.target
                          ? `→ ${shortHash(event.body.target, 6, 4)}`
                          : ""}
                  </span>
                  <Copyable
                    value={event.id}
                    label={shortHash(event.id, 6, 4)}
                    className="mono text-[10px]"
                    title={`prev ${event.prev || "genesis"}`}
                  />
                  <span className="mono shrink-0 text-[10px] text-primary" title="signature verified">
                    ✓
                  </span>
                </div>
              ))
            )}
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              Each event stores the id of the one before it. To change a sentence you would have to
              re-sign every event after it — with a key you do not have.
            </p>
            <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Link2 className="size-3.5" />
              Your key: {identity.publicKey.slice(0, 12)}…
            </p>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
