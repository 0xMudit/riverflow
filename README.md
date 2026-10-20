# River

A peer-to-peer social network whose ledger forgets nothing.

No server. No company. No account to suspend. Every post, edit, reaction and
retraction is a signed event appended to its author's own hash-chained log, and
nodes gossip those logs to each other directly. To delete something from River
you would have to delete it from every machine that ever synced it — which is
what "nothing is deleted" actually means.

```
RiverFlow/
  src/core/      pure ledger: events, canonical hashing, ed25519, log verification
  src/main/      the node: SQLite store, TCP transport, sync, identity, Electron main
  src/preload/   the narrow IPC bridge
  src/renderer/  the window (React)
  scripts/       headless proofs: two nodes, unit tests, a demo peer, a QA driver
  prototype-web/ the first browser prototype, kept for reference and not maintained
```

---

## The shape of the ledger

One global chain cannot serve a million people writing at once: it forces a
single total order over everyone's words and makes every writer wait for a
block. River uses the structure real decentralised social networks converge on:

- **One hash-chained log per identity.** An event stores `seq`, `prev` (the id of
  the event before it in *that* author's log) and an ed25519 signature. You
  cannot reorder, truncate or back-date an author's history without breaking
  every link after it.
- **A DAG across identities.** Replies, edits, retractions and reactions
  reference event ids. The union of all logs — linked by those references — is
  the network's ledger. There is nothing global to agree on, so there is no
  mining and no proof-of-work.
- **Content-addressed ids.** `id = sha256(canonical{author, seq, prev, kind, body,
  createdAt})`. Change one byte and the id changes, the signature no longer
  covers it, and every later event in that log loses its parent.
- **Retraction is an event, not a deletion.** `retract` writes a tombstone on top
  of the words. The feed hides it ("silt"), the log keeps it, and the provenance
  drawer shows both.

```
alice:  #0 post ──▶ #1 profile ──▶ #2 edit(→#0) ──▶ #3 retract(→#0)
bob:    #0 reaction(→alice#0) ──▶ #1 reply(→alice#0)
```

## How two nodes meet

There is no rendezvous server. `src/main/transport.ts` gives each node:

1. a TCP listener that speaks newline-delimited JSON frames, and
2. a UDP broadcast every four seconds so nodes on the same network find each
   other with no directory at all.

Once connected, nodes exchange only what the other is missing:

```
hello  { nodeId, port, heads: [[author, seq], …] }
want   { ranges: [[author, fromSeq, toSeq], …] }
events { events: [ … ] }
have   { heads: [ … ] }          ← gossip: forward what you learn
```

Every arriving event is verified before a byte is written: shape, position in
the author's log, `prev` link, then the signature. Junk never lands. New events
are gossiped onward, so a post reaches nodes whose owners never met its author.

## Storage

Node 24 ships SQLite in core, so there is no native build and no ORM.

- `events`, `heads` — the truth. Insert-only.
- `posts`, `profiles`, `follows`, `reactions`, `trail` — derived views, rebuilt by
  replaying the log (`Store.rebuild()`). If a view disagrees with the log, the log
  wins.
- Events that arrive before the thing they reference are parked in `deferred` and
  applied when the parent lands, so arbitrary arrival order is fine.

## The security model

- The ed25519 private key is generated on this machine and sealed with the OS
  keychain (`safeStorage` → DPAPI on Windows, Keychain on macOS).
- Signing happens in the node process. The renderer never receives the key —
  it asks for a signature, not a secret. The one exception is an explicit,
  user-initiated backup.
- The renderer has no filesystem, no sockets and no Node integration; it talks
  to the node over a fixed IPC surface (`src/core/bridge.ts`).
- There is no password reset and no recovery. Lose the key and that identity
  becomes a reader forever; its history stays on the network.

## Run it

```bash
npm install
npm run dev        # the desktop app
npm test           # 29 ledger invariants (tampering, forks, disorder, silt, rebuild)
npm run demo       # two real nodes syncing over TCP, in one terminal
```

Two people on the same network find each other automatically. Across networks,
either side shares the address shown under **The network** and the other dials
it. To try it alone, run a second node:

```bash
npx tsx scripts/peer.ts --name mira --port 7400 --peers 127.0.0.1:7331 --demo
```

`npm run drive` launches the app under Playwright, writes a few posts, brings
that second node online and screenshots the result into `shots/`.

## What is built, and what is not

Built and tested: per-author hash chains, signature verification on ingest,
out-of-order resolution, tombstone retraction with provenance, per-author
profiles and follows, reactions, gossip sync, LAN discovery, live verification
and an in-memory tamper simulation that never touches the database.

Not built yet, in the order that matters:

1. **DHT transport** (Hyperswarm) so peers find each other across NATs with no
   shared bootstrap host. TCP + LAN discovery is the honest local-first step.
2. **Relay caching** — always-on nodes that hold logs for people who are offline.
   Without them, delivery is best-effort: your node must be reachable to sync.
3. **Notifications** — derived locally from new events by authors you follow.
4. **Local ranking** — "for you" computed on-device from your follow graph, never
   from a server-side profile of you.
5. **Media** — content-addressed blobs referenced by hash, fetched from whoever
   has them, verified on receipt.
6. **Moderation that is local** — mutes, filters, blocklists you choose. Nothing
   can be deleted globally; what you see is a choice you make and can prove.
7. **Device subkeys** so one identity can write from two machines without forking
   its log. Today: one key, one writer.
8. **Mobile**, and a web reader for people who will not install anything.

## Scale, honestly

A million users is a property of a network, not a switch. The parts that will
need work first:

- `hello`/`have` currently exchange a head per author. At millions of authors
  that payload must be sharded or replaced with subscription sets and range
  summaries.
- Full-log verification on ingest is O(history) for a new author. Checkpoints and
  Merkle proofs let a node trust a suffix without replaying everything.
- One global discovery topic does not survive a million peers; topics need to
  shard by interest, with relays carrying the load.

None of those change the data model. Each author's log stays append-only and
independently verifiable, which is the property worth protecting.

## The prototype

`prototype-web/` is the first version: a Next.js app with a single mined chain.
It is kept as a design and code reference, is not maintained, and is not part of
the build. The current model replaced it because a global proof-of-work chain
cannot carry a million simultaneous writers.

## License

MIT — see [LICENSE](LICENSE).

Built and published by [0xMudit](https://github.com/0xMudit) · repo:
`github.com/0xMudit/riverflow`.
