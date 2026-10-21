# River

A peer-to-peer social network whose ledger forgets nothing.

No server. No company. No account to suspend. Every post, edit, reaction and
retraction is a signed event appended to its author's own hash-chained log, and
nodes gossip those logs to each other directly. To delete something from River
you would have to delete it from every machine that ever synced it — which is
what "nothing is deleted" actually means.

```
RiverFlow/
  src/core/      pure ledger: events, canonical hashing, ed25519, merkle, wire protocol
  src/main/      the node: SQLite store, TCP + DHT transport, sync, identity, Electron main
  src/preload/   the narrow IPC bridge
  src/renderer/  the window (React)
  scripts/       headless proofs: two nodes, unit tests, a DHT demo, a relay, a bootstrap node
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
- **One chain per device, per identity.** A phone, a laptop and a desktop each
  keep their own chain, and the identity signs a `device` event naming the keys
  it trusts. Two machines therefore never fork one person's history, and a
  stolen laptop can be dropped without losing the past.
- **A DAG across identities.** Replies, edits, retractions and reactions
  reference event ids. The union of all logs — linked by those references — is
  the network's ledger. There is nothing global to agree on, so there is no
  mining and no proof-of-work.
- **Content-addressed ids.** `id = sha256(canonical{author, device, seq, prev,
  kind, body, createdAt})`. Change one byte and the id changes, the signature
  no longer covers it, and every later event in that log loses its parent.
- **Retraction is an event, not a deletion.** `retract` writes a tombstone on top
  of the words. The feed hides it ("silt"), the log keeps it, and the provenance
  drawer shows both.
- **Signed Merkle checkpoints.** Every minute a node signs a Merkle root over
  its own chain and gossips it. A node that missed a year of somebody's log can
  be handed the root and a short inclusion proof and check what it holds
  without replaying everything.

```
alice:  #0 post ──▶ #1 profile ──▶ #2 edit(→#0) ──▶ #3 retract(→#0)
bob:    #0 reaction(→alice#0) ──▶ #1 reply(→alice#0)
```

## How two nodes meet

There is no rendezvous server and no directory of users. `src/main/transport.ts`
gives each node three ways in:

1. **TCP** — an address someone gave you. Newline-delimited JSON frames.
2. **LAN discovery** — a UDP broadcast every four seconds, so two machines on
   the same network find each other with no directory at all.
3. **The DHT** — peers announce a topic and a distributed table tells them who
   else is listening; a hole is then punched through both firewalls. The
   traffic is Noise-encrypted end to end, so the table moves addresses and
   never sees a post. This is how a node behind a router is reachable at all.

Whichever way two nodes meet, the first thing they do is **prove who they
are**: a signed hello carries a random nonce, a key id and an ed25519
signature over both. A peer that cannot sign for the key it claims is dropped
before it is allowed to say anything.

```
hello  { peer, addr, nonce, sig, chains: [[author, device, seq], …] }
have   { chains: [[author, device, seq], …] }
subs   { authors: [ … ] }
want   { ranges: [[author, device, from, to], …] }
events { events: [ … ] }
checkpoint / proof / blob-want / blob-chunk / ping / pong / bye
```

Every arriving event is verified before a byte is written: shape, position in
the author's chain, `prev` link, then the signature. Junk never lands. New
events are gossiped onward, so a post reaches nodes whose owners never met its
author.

**Nobody exchanges a head for every author in the world.** A node publishes the
authors it has subscribed to and asks only for those. A chain it has never seen
is *sampled* — the last few events — so it can learn that somebody exists
without pulling their whole history. A relay, which exists to hold other
people's logs, asks for all of it.

## Storage

Node 24 ships SQLite in core, so there is no native build and no ORM.

- `events`, `chains` — the truth. Insert-only.
- `posts`, `profiles`, `follows`, `reactions`, `trail`, `notifications` —
  derived views, rebuilt by replaying the log (`Store.rebuild()`). If a view
  disagrees with the log, the log wins.
- `checkpoints` — signed Merkle roots, with their proofs.
- `blobs` — media, addressed by the hash of its bytes.
- `subscriptions`, `wanted`, `known_peers` — who to listen for, what is still
  missing, and who we have met before.
- `mutes`, `prefs` — local moderation. Never an event, never shared.
- Events that arrive before the thing they reference are parked in `deferred` and
  applied when the parent lands, so arbitrary arrival order is fine.

**Everything on your disk is sealed.** The words — event bodies, post text,
names, retraction reasons, notification snippets — are encrypted with AES-256-GCM
under a data key that only the operating system's keychain can open. The
ledger's *structure* (who wrote, when, how many events) stays readable, because
a log you cannot index is not a log. The content is yours alone: another
program on the machine, or somebody with the disk, finds ciphertext. A store
written before sealing existed is sealed in place the first time a node with a
data key opens it, and vacuumed afterwards, so the old cleartext leaves the
file with it.

## Wallets

People already carry keys: in MetaMask, in Rabby, in a hardware wallet, in a
seed phrase they wrote down. River accepts them.

Any wallet that speaks EIP-1193 — MetaMask, Rabby, Brave, anything that answers
`eth_requestAccounts` — can be an author. The signing is EIP-191
`personal_sign` over the event's id, and the address the signature recovers to
*is* the author, so the wallet cannot write as anybody else. The event model
gained a second scheme for this: `scheme: "eth"` on the event, with a 65-byte
signature instead of 64. Everything else — the hash chain, the Merkle
checkpoints, the device subkeys, the whole ledger — works the same.

Two things follow from that, and both matter:

- **A wallet is optional.** The default is still the ed25519 key in the
  operating system's keychain, and nobody needs a wallet to use River. The
  wallet is another way to hold the same authority, not a dependency on
  anybody's company. River does not phone home, does not require an account,
  and does not care who made the wallet.
- **Signing in is signing.** There is no server to log in to, so "sign in" is
  the thing people already know: the node makes a statement with a one-shot
  nonce, the wallet signs it, and the node checks the signature. That is
  EIP-4361 without the chain, and it is what a web reader would use.

The key never leaves the wallet. The node prepares the event — where it goes
in the chain, what its id will be — and the window asks the wallet to sign
that id; the node checks the signature and files it. The window never sees a
private key, and neither does the node.

## The security model

- The ed25519 private key is generated on this machine and sealed with the OS
  keychain (`safeStorage` → DPAPI on Windows, Keychain on macOS).
- Signing happens in the node process. The renderer never receives the key —
  it asks for a signature, not a secret. The one exception is an explicit,
  user-initiated backup.
- A second key, the *data key*, seals everything the node keeps on the disk.
  It is generated once and sealed the same way.
- A third key, the *peer key*, identifies the machine on the network and
  signs the handshake. It is separate from the author key on purpose: you can
  drop a machine without touching your history.
- The renderer has no filesystem, no sockets and no Node integration; it talks
  to the node over a fixed IPC surface (`src/core/bridge.ts`).
- There is no password reset and no recovery. Lose the key and that identity
  becomes a reader forever; its history stays on the network.

## Run it

```bash
npm install
npm run dev        # the desktop app
npm test           # 134 ledger invariants (tampering, forks, disorder, silt, rebuild,
                   #   merkle proofs, device keys, blobs, notifications, migration,
                   #   sealed-at-rest, wallet signatures and sign-in)
npm run demo       # two real nodes syncing over TCP, in one terminal
npm run dht        # two real nodes finding each other through a DHT, no address typed in
npm run bootstrap  # a DHT node of your own
npm run relay      # a headless relay that holds other people's logs
```

Two people on the same network find each other automatically. Across networks,
the DHT introduces them — or, to cross without it, either side shares the
address shown under **The network** and the other dials it. To try it alone,
run a second node:

```bash
npx tsx scripts/peer.ts --name mira --port 7400 --peers 127.0.0.1:7331 --demo
```

`npm run drive` launches the app under Playwright, writes a few posts, brings
that second node online and screenshots the result into `shots/`.

There is a terminal client too, and it is a real node: the same store, the same
key, the same protocol.

```bash
npx tsx src/cli/index.ts init                 # create an identity
npx tsx src/cli/index.ts post "hello there"    # write to your log
npx tsx src/cli/index.ts feed                 # what you see when you look
npx tsx src/cli/index.ts serve --port 7331    # stay online for other nodes
npx tsx src/cli/index.ts help                 # everything else
```

## What "nobody can take this down" actually means

Being honest is the point of this project, so here is the claim in full.

**What the design does give you**

- There is no company to sue, no account to ban, and no database to seize. A
  takedown order against a server does nothing because there is no server.
- Content is addressed by its own hash and signed by the author's key. A
  gateway can refuse to *forward* a post; it cannot produce a different post
  with the same id, and it cannot remove one event without breaking the chain
  that follows it.
- The network has no privileged node. Bootstrap nodes are interchangeable and
  any number of people can run one; a relay holds a cache, not a record, and
  losing it loses nothing.
- Every machine keeps its own copy. A node that is switched off, seized or
  deleted has lost a copy, not the history.

**What it does not give you**

- A government with the power to cut your ISP can stop you reaching the
  network, and no protocol can talk its way past that. What it can stop is
  *targeted* removal and *targeted* account-taking.
- A small network is small. If every node you know is seized at once, your
  history survives only where it was copied. That is why relays exist, why
  checkpoints are gossiped rather than requested, and why you should run a
  bootstrap node of your own.
- The DHT is a directory of *locations*, not of content. It cannot read your
  posts, but it can see which addresses are talking, and a very determined
  adversary can still try to eclipse a node by surrounding it. Peers
  subscribe, sample and gossip, which makes that expensive rather than
  impossible.
- "Nothing is deleted" is a property of the *log*, not a promise about the
  world. A post can always be ignored, and it can always be lied about in
  conversation.

The honest summary: River removes the chokepoint, not the adversary. It makes
removal local, provable, and expensive — and it makes the network survive the
loss of any single machine, including the one running it.

## Writing the node in another language

The app is TypeScript because the window is a web page and the node and the
window have to agree on every byte they exchange. The **wire protocol is the
contract**, and it is deliberately small: framed JSON, one signed handshake,
seven message types. A node written in Rust, Go, C++ or Python can join the
network beside this one, because it only has to speak the protocol and verify
the same signatures.

That matters for the places where a native core is worth it: a single static
binary for relays and phones, where shipping a JavaScript runtime is the
problem, and the hot paths — ed25519, hashing, Merkle trees, SQLite — under
load. The TypeScript implementation stays the reference, with its 79
invariants as the specification.

## Scale, honestly

A million users is a property of a network, not a switch. The parts that will
need work first:

- The DHT announces one topic. At a million peers, topics need to shard by
  interest, with relays carrying the load.
- Full-log verification on ingest is O(history) for a new author. Checkpoints
  and Merkle proofs let a node trust a suffix without replaying everything —
  that is built, but the peer-to-peer proof exchange is not.
- A node still samples a stranger's log rather than mirroring it, so a relay
  that mirrors everyone needs a real storage policy, not a quota constant.

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
