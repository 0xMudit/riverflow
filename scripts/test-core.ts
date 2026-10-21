/**
 * Unit tests for the ledger rules. No network, no UI — just the invariants that
 * make "nothing is deleted" mean something.
 *
 *   npm test
 */
import { rm, copyFile, readFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { generateKeyPair, sign, verify, type KeyPair } from "../src/core/crypto";
import { fromHex, toHex } from "../src/core/canonical";
import { createEvent, eventId, verifyEvent } from "../src/core/events";
import { blobHash, BlobTransfer, chunkBytes, joinChunks, verifyBlob } from "../src/core/blobs";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  checkpointPayload,
  merkleProof,
  merkleRoot,
  verifyCheckpoint,
  verifyMerkleProof,
  type Checkpoint,
  type MerkleProof,
} from "../src/core/merkle";
import { rankFeed } from "../src/core/rank";
import { encodeFrame, FrameDecoder, signHello, utf8Length, verifyHello } from "../src/core/wire";
import {
  ETH_ADDRESS,
  addressFromPublicKey,
  formatSiwe,
  personalSignDigest,
  recoverAddress,
  verifyPersonalSignature,
  verifySiwe,
} from "../src/core/eth";
import type { Event, EventBody, EventKind } from "../src/core/types";
import { Store } from "../src/main/store";

let passed = 0;
let failed = 0;

/** An event signed by a wallet, the way a browser wallet would sign it. */
async function createEthEvent(
  privateKey: Uint8Array,
  author: string,
  seq: number,
  prev: string,
  kind: EventKind,
  body: EventBody,
  createdAt = Date.now(),
): Promise<Event> {
  const id = await eventId({ author, scheme: "eth", seq, prev, kind, body, createdAt });
  const signature = walletSignature(personalSignDigest(fromHex(id)), privateKey, author);
  return { id, author, scheme: "eth", seq, prev, kind, body, createdAt, sig: toHex(signature) };
}

/** A wallet signature: r || s || v, with v as 27 or 28. */
function walletSignature(digest: Uint8Array, privateKey: Uint8Array, address: string): Uint8Array {
  const compact = secp256k1.sign(digest, privateKey, { prehash: false });
  // Find the recovery id by asking which candidate lifts back to the address.
  for (let candidate = 0; candidate < 4; candidate++) {
    try {
      const parsed = secp256k1.Signature.fromBytes(compact, "compact");
      const withBit = parsed.addRecoveryBit(candidate);
      const recovered = addressFromPublicKey(withBit.recoverPublicKey(digest).toBytes(false));
      if (recovered.toLowerCase() === address.toLowerCase()) {
        const out = new Uint8Array(65);
        out.set(compact, 0);
        out[64] = 27 + candidate;
        return out;
      }
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error("could not find the recovery id for this signature");
}

function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  const dir = join(tmpdir(), `river-unit-${Date.now().toString(36)}`);
  const dataKey = randomBytes(32);
  const store = new Store(join(dir, "river.db"), { dataKey });
  const alice = await generateKeyPair();
  const bob = await generateKeyPair();

  const draft = async (keys: KeyPair, kind: EventKind, body: EventBody): Promise<Event> => {
    const slot = store.nextSlot(keys.publicKey);
    return createEvent(keys.privateKey, {
      author: keys.publicKey,
      seq: slot.seq,
      prev: slot.prev,
      kind,
      body,
    });
  };

  // ---------------------------------------------------------------- append

  console.log("\nappend");

  const alicePost = await draft(alice, "post", { text: "the first stone" });
  const first = await store.ingest(alicePost);
  check("seq 0 is accepted", first.status === "added", first.reason);
  check("the head advanced", store.head(alice.publicKey)?.seq === 0);

  const duplicate = await store.ingest(alicePost);
  check("the same event twice is a duplicate", duplicate.status === "duplicate");

  const fork = await createEvent(alice.privateKey, {
    author: alice.publicKey,
    seq: 0,
    prev: "",
    kind: "post",
    body: { text: "a different first stone" },
  });
  const forked = await store.ingest(fork);
  check("a second event at a claimed seq is rejected", forked.status === "invalid", forked.reason);

  const leap = await createEvent(alice.privateKey, {
    author: alice.publicKey,
    seq: 5,
    prev: "a".repeat(64),
    kind: "post",
    body: { text: "out of order" },
  });
  check("a gap is refused", (await store.ingest(leap)).status === "gap");

  // ----------------------------------------------------------- authenticity

  console.log("\nauthenticity");

  const next = await draft(alice, "post", { text: "the second stone" });
  const rewrittenBody = { ...next, body: { text: "rewritten history" } };
  const rewritten = { ...rewrittenBody, id: await eventId(rewrittenBody) };
  const rewriteResult = await store.ingest(rewritten);
  check(
    "rewritten text fails its signature",
    rewriteResult.status === "invalid" && /signature/.test(rewriteResult.reason ?? ""),
    rewriteResult.reason,
  );

  const sigByBob = await sign(bob.privateKey, fromHex(next.id));
  const forged = { ...next, sig: sigByBob };
  const forgedResult = await store.ingest(forged);
  check(
    "a signature by another key is refused",
    forgedResult.status === "invalid" && /signature/.test(forgedResult.reason ?? ""),
    forgedResult.reason,
  );

  await store.ingest(next);
  check("the genuine event is accepted", store.head(alice.publicKey)?.seq === 1);

  // ------------------------------------------------------- arrival disorder

  console.log("\ndisorder");

  const carol = await generateKeyPair();
  const carolPost = await createEvent(carol.privateKey, {
    author: carol.publicKey,
    seq: 0,
    prev: "",
    kind: "post",
    body: { text: "not yet arrived" },
  });

  await store.ingest(await draft(bob, "post", { text: "bob speaks first" }));
  await store.ingest(await draft(bob, "reaction", { target: carolPost.id, emoji: "≈" }));
  check("an early reaction is parked, not dropped", store.eventCount() === 4, `${store.eventCount()} events`);

  await store.ingest(carolPost);
  const carolView = store.feed({}).top.find((post) => post.id === carolPost.id);
  check("it applies when its post arrives", carolView?.reactions === 1, `got ${carolView?.reactions}`);

  await store.ingest(await draft(bob, "post", { text: "a reply from elsewhere", replyTo: carolPost.id }));
  check("replies attach to their parent", store.feed({}).top.find((p) => p.id === carolPost.id)?.replyCount === 1);

  const replyRow = store.feed({}).replies.find((post) => post.author === bob.publicKey);
  check("replies keep their root", replyRow?.root === carolPost.id);

  // --------------------------------------------------- out-of-order threading

  console.log("\nthreading");

  const erin = await generateKeyPair();
  const frank = await generateKeyPair();
  const leafAuthor = await generateKeyPair();

  // A three-level thread arriving in reverse: the leaf, then the middle, then
  // the top. Nothing knows where it belongs until the top arrives.
  const rootPost = await createEvent(erin.privateKey, {
    author: erin.publicKey,
    seq: 0,
    prev: "",
    kind: "post",
    body: { text: "the top of it" },
  });
  const middle = await createEvent(frank.privateKey, {
    author: frank.publicKey,
    seq: 0,
    prev: "",
    kind: "post",
    body: { text: "the middle", replyTo: rootPost.id },
  });
  const leaf = await createEvent(leafAuthor.privateKey, {
    author: leafAuthor.publicKey,
    seq: 0,
    prev: "",
    kind: "post",
    body: { text: "the leaf", replyTo: middle.id },
  });

  await store.ingest(leaf);
  await store.ingest(middle);
  await store.ingest(rootPost);

  const threaded = store.feed({ includeSilt: true });
  const leafRow = threaded.replies.find((post) => post.id === leaf.id);
  const middleRow = threaded.replies.find((post) => post.id === middle.id);
  check("a reply that arrived first finds its thread", leafRow?.root === rootPost.id, `root ${leafRow?.root}`);
  check("the reply in between does too", middleRow?.root === rootPost.id, `root ${middleRow?.root}`);
  check("the leaf is in the feed", Boolean(leafRow));
  check("the top post counts its reply", threaded.top.find((p) => p.id === rootPost.id)?.replyCount === 1);
  check("the middle post counts its reply", threaded.replies.find((p) => p.id === middle.id)?.replyCount === 1);
  check("the thread view finds every post", store.thread(rootPost.id).posts.length === 3);

  // The same thread, in order, must look the same. Order of arrival is not a
  // property of the conversation.
  const orderDir = join(tmpdir(), `river-order-${Date.now().toString(36)}`);
  const ordered = new Store(join(orderDir, "river.db"));
  await ordered.ingest(rootPost);
  await ordered.ingest(middle);
  await ordered.ingest(leaf);
  const inOrder = ordered.feed({ includeSilt: true });
  const thread3 = [rootPost.id, middle.id, leaf.id];
  const pick = (page: { top: Array<{ id: string; root: string | null; replyCount: number }>; replies: Array<{ id: string; root: string | null; replyCount: number }> }) =>
    [...page.top, ...page.replies]
      .filter((post) => thread3.includes(post.id))
      .map((post) => [post.id, post.root, post.replyCount])
      .sort();
  check(
    "the thread does not depend on the order of arrival",
    JSON.stringify(pick(inOrder)) === JSON.stringify(pick(threaded)),
    JSON.stringify(pick(inOrder)),
  );
  ordered.close();
  await rm(orderDir, { recursive: true, force: true });

  // ---------------------------------------------------------------- the clock

  console.log("\nthe clock");

  const slot = store.nextSlot(bob.publicKey);
  const future = await createEvent(
    bob.privateKey,
    { author: bob.publicKey, seq: slot.seq, prev: slot.prev, kind: "post", body: { text: "pinned" } },
    Date.now() + 365 * 24 * 3600 * 1000,
  );
  const futureResult = await store.ingest(future);
  check(
    "an event from the future is refused",
    futureResult.status === "invalid" && /future/.test(futureResult.reason ?? ""),
    futureResult.reason,
  );

  const skewed = await createEvent(
    bob.privateKey,
    { author: bob.publicKey, seq: slot.seq, prev: slot.prev, kind: "post", body: { text: "a minute ahead" } },
    Date.now() + 60 * 1000,
  );
  check("a minute of clock skew is allowed", (await store.ingest(skewed)).status === "added");

  // ------------------------------------------------------- a ripple withdrawn

  console.log("\na ripple withdrawn");

  const grace = await generateKeyPair();
  const gracePost = await draft(erin, "post", { text: "count the ripples" });
  await store.ingest(gracePost);
  await store.ingest(await draft(grace, "reaction", { target: gracePost.id, emoji: "≈" }));
  const told = store.notifications(erin.publicKey).filter((note) => note.kind === "reaction").length;
  await store.ingest(await draft(grace, "reaction", { target: gracePost.id, emoji: "" }));
  const toldAgain = store.notifications(erin.publicKey).filter((note) => note.kind === "reaction").length;
  check("a ripple tells the author", told === 1, `${told}`);
  check("taking it back does not tell them again", toldAgain === 1, `${toldAgain}`);
  check(
    "the ripple is gone from the post",
    store.feed({ includeSilt: true }).top.find((p) => p.id === gracePost.id)?.reactions === 0,
  );

  // ------------------------------------------------------ edits by strangers

  console.log("\nedits by strangers");

  const intruder = await generateKeyPair();
  const ownPost = await draft(erin, "post", { text: "my words" });
  await store.ingest(ownPost);
  const waiting = (store.db.prepare("SELECT COUNT(*) AS n FROM deferred").get() as { n: number }).n;
  await store.ingest(await draft(intruder, "edit", { target: ownPost.id, text: "your words now" }));
  check(
    "a stranger cannot edit your post",
    store.feed({ includeSilt: true }).top.find((p) => p.id === ownPost.id)?.text === "my words",
  );
  check(
    "a stranger's edit is not left waiting for ever",
    (store.db.prepare("SELECT COUNT(*) AS n FROM deferred").get() as { n: number }).n === waiting,
  );
  check("the attempt is still on the log", store.trailFor(ownPost.id).some((event) => event.kind === "edit"));

  // ------------------------------------------------------------------ silt

  console.log("\nsilt");

  const before = store.eventCount();
  await store.ingest(await draft(alice, "retract", { target: alicePost.id, reason: "served its purpose" }));
  check("a retraction is a new event", store.eventCount() === before + 1);
  check("the post leaves the flow", !store.feed({}).top.some((post) => post.id === alicePost.id));
  check("the post is still reachable", store.feed({ includeSilt: true }).top.some((post) => post.id === alicePost.id));

  const trail = store.trailFor(alicePost.id);
  check("provenance keeps write and retraction", trail.length === 2, `${trail.length} events`);
  check(
    "the original words are still in the log",
    trail[0]?.kind === "post" && trail[0]?.body.text === "the first stone",
  );

  // ------------------------------------------------------------------ views

  console.log("\nviews");

  await store.ingest(await draft(alice, "profile", { name: "alice", bio: "keeps receipts", hue: 168 }));
  check("a profile resolves", store.profile(alice.publicKey)?.name === "alice");

  await store.ingest(await draft(alice, "profile", { name: "alice (renamed)", bio: "", hue: 168 }));
  check("a newer profile wins", store.profile(alice.publicKey)?.name === "alice (renamed)");

  await store.ingest(await draft(bob, "follow", { target: alice.publicKey }));
  check("follows are directional", store.following(bob.publicKey).includes(alice.publicKey));
  check("and visible from the other side", store.followers(alice.publicKey).includes(bob.publicKey));

  await store.ingest(await draft(bob, "follow", { target: alice.publicKey, unfollow: true }));
  check("unfollowing withdraws the follow", !store.following(bob.publicKey).includes(alice.publicKey));

  // ------------------------------------------------------------ verification

  console.log("\nverification");

  const report = await store.verifyAll();
  check("the whole ledger verifies", report.ok, report.errors[0]?.detail);
  check("every event was checked", report.events === store.eventCount(), `${report.events}`);

  const erased = await store.simulateBreach(alice.publicKey, "erase");
  check("erasing an event is detected", !erased.ok && erased.errors[0]?.code === "gap");

  const rewriteSim = await store.simulateBreach(alice.publicKey, "rewrite");
  check("rewriting an event is detected", !rewriteSim.ok && rewriteSim.errors[0]?.code === "bad-signature");

  check("the simulation changed nothing on disk", (await store.verifyAll()).ok);

  // ---------------------------------------------------------------- rebuild

  console.log("\nrebuild");

  const snapshotBefore = JSON.stringify(store.feed({ includeSilt: true }));
  store.rebuild();
  const snapshotAfter = JSON.stringify(store.feed({ includeSilt: true }));
  check("derived tables rebuild from the log alone", snapshotBefore === snapshotAfter);
  check("the log itself is untouched", (await store.verifyAll()).ok);

  // ------------------------------------------------------------- checkpoints

  console.log("\ncheckpoints");

  const aliceChain = store.chainIds(alice.publicKey, "");
  const root = await merkleRoot(aliceChain);
  const proof = await merkleProof(aliceChain, 0);
  check("a root covers the whole chain", aliceChain.length > 0 && root.length === 64);
  check("a proof verifies against its root", await verifyMerkleProof(aliceChain[0] as string, proof));
  check(
    "a proof does not verify against a wrong leaf",
    !(await verifyMerkleProof("0".repeat(64), proof)),
  );
  const tampered = { ...(proof as MerkleProof), path: [...(proof as MerkleProof).path] };
  tampered.path[0] = "1".repeat(64);
  check("a tampered proof is refused", !(await verifyMerkleProof(aliceChain[0] as string, tampered)));
  check(
    "the root changes when the chain changes",
    (await merkleRoot([...aliceChain, "f".repeat(64)])) !== root,
  );

  const checkpoint: Checkpoint = {
    author: alice.publicKey,
    device: "",
    seq: store.head(alice.publicKey, "")?.seq ?? 0,
    root,
    count: aliceChain.length,
    at: Date.now(),
  };
  const checkpointSig = await sign(
    alice.privateKey,
    new TextEncoder().encode(checkpointPayload(checkpoint)),
  );
  check(
    "a signed checkpoint verifies",
    await verifyCheckpoint({ ...checkpoint, sig: checkpointSig }, (payload, signature) =>
      verify(alice.publicKey, new TextEncoder().encode(payload), signature),
    ),
  );
  check(
    "a checkpoint signed by someone else does not",
    !(await verifyCheckpoint({ ...checkpoint, sig: await sign(bob.privateKey, new TextEncoder().encode(checkpointPayload(checkpoint))) }, (payload, signature) =>
      verify(alice.publicKey, new TextEncoder().encode(payload), signature),
    )),
  );
  store.saveCheckpoint(checkpoint, checkpointSig);
  check("the store keeps the checkpoint", store.latestCheckpoint(alice.publicKey, "")?.root === root);

  // ----------------------------------------------------------------- devices

  console.log("\ndevices");

  const phone = await generateKeyPair();
  const stranger = await generateKeyPair();
  const rootSeqBeforeDevice = store.head(alice.publicKey, "")?.seq ?? -1;

  await store.ingest(await draft(alice, "device", { device: phone.publicKey, name: "phone" }));
  check("the device is registered", store.deviceRegistered(alice.publicKey, phone.publicKey));
  check("an unknown device is not", !store.deviceRegistered(alice.publicKey, stranger.publicKey));

  const deviceSlot = store.nextSlot(alice.publicKey, phone.publicKey);
  const fromPhone = await createEvent(phone.privateKey, {
    author: alice.publicKey,
    device: phone.publicKey,
    seq: deviceSlot.seq,
    prev: deviceSlot.prev,
    kind: "post",
    body: { text: "sent from the phone" },
  });
  const deviceResult = await store.ingest(fromPhone);
  check("an authorised device may write", deviceResult.status === "added", deviceResult.reason);
  check("the device keeps its own chain", store.head(alice.publicKey, phone.publicKey)?.seq === 0);
  check(
    "the root chain advanced by the registration alone",
    store.head(alice.publicKey, "")?.seq === rootSeqBeforeDevice + 1,
  );

  const strangerSlot = store.nextSlot(alice.publicKey, stranger.publicKey);
  const fromStranger = await createEvent(stranger.privateKey, {
    author: alice.publicKey,
    device: stranger.publicKey,
    seq: strangerSlot.seq,
    prev: strangerSlot.prev,
    kind: "post",
    body: { text: "nobody asked me" },
  });
  check(
    "an unauthorised device is refused",
    (await store.ingest(fromStranger)).status === "invalid",
  );

  const deviceFork = await createEvent(phone.privateKey, {
    author: alice.publicKey,
    device: phone.publicKey,
    seq: 0,
    prev: "",
    kind: "post",
    body: { text: "a second beginning" },
  });
  check("a device cannot fork its own chain", (await store.ingest(deviceFork)).status === "invalid");
  check("the ledger still verifies", (await store.verifyAll()).ok);

  // ------------------------------------------------------------------- blobs

  console.log("\nblobs");

  const bytes = new TextEncoder().encode("a picture, more or less");
  const hash = await blobHash(bytes);
  check("the hash matches the bytes", await verifyBlob(hash, bytes));
  check("a wrong hash is refused", !(await verifyBlob(hash, new TextEncoder().encode("elsewhere"))));
  check("an empty blob has a hash", (await blobHash(new Uint8Array(0))).length === 64);
  const chunks = chunkBytes(bytes, 8);
  check("chunks reassemble into the same bytes", toHex(joinChunks(chunks)) === toHex(bytes));
  store.putBlob({ hash, size: bytes.length, type: "text/plain" }, bytes);
  check("the store keeps the blob", store.hasBlob(hash));
  check(
    "the blob comes back byte for byte",
    toHex((store.getBlob(hash) as { bytes: Uint8Array }).bytes) === toHex(bytes),
  );

  // A peer is not trusted with this machine's memory.
  const transfer = new BlobTransfer(1024, 4, 1000, () => 1000);
  const picture = new TextEncoder().encode("a picture in pieces");
  const pictureHash = await blobHash(picture);
  const pieces = chunkBytes(picture, 8);
  let assembled: Uint8Array | null = null;
  for (const [index, piece] of pieces.entries()) {
    const result = transfer.accept(pictureHash, index, pieces.length, toHex(piece));
    if (result.status === "complete") assembled = result.bytes;
  }
  check("a blob arrives in pieces", assembled !== null && toHex(assembled) === toHex(picture));

  const tooBig = new BlobTransfer(16, 4, 1000, () => 1000);
  const huge = toHex(new Uint8Array(64));
  const bigResult = tooBig.accept(pictureHash, 0, 2, huge);
  check(
    "a blob larger than the cap is refused",
    bigResult.status === "rejected" && /larger/.test(bigResult.reason),
    bigResult.status === "rejected" ? bigResult.reason : bigResult.status,
  );

  const changed = new BlobTransfer(1024, 4, 1000, () => 1000);
  changed.accept(pictureHash, 0, 3, toHex(pieces[0] as Uint8Array));
  const changedResult = changed.accept(pictureHash, 1, 4, toHex(pieces[1] as Uint8Array));
  check(
    "a peer may not change its mind about the size",
    changedResult.status === "rejected" && /size/.test(changedResult.reason),
  );

  const gappy = new BlobTransfer(1024, 4, 1000, () => 1000);
  gappy.accept(pictureHash, 0, 3, toHex(pieces[0] as Uint8Array));
  const gappyResult = gappy.accept(pictureHash, 2, 3, toHex(pieces[2] as Uint8Array));
  check("a blob with a hole in it does not finish", gappyResult.status === "pending");
  check("the hole is not a finished blob", gappy.size === 1);

  const bounded = new BlobTransfer(1024, 2, 1000, () => 1000);
  bounded.accept(pictureHash, 0, 1, "00");
  bounded.accept("b".repeat(64), 0, 1, "00");
  bounded.accept("c".repeat(64), 0, 1, "00");
  check("the number of open transfers is bounded", bounded.size <= 2, `${bounded.size}`);

  let clock = 1000;
  const stalling = new BlobTransfer(1024, 4, 100, () => clock);
  stalling.accept(pictureHash, 0, 3, toHex(pieces[0] as Uint8Array));
  check("a stalled transfer is still open", stalling.size === 1);
  clock = 1200;
  stalling.prune();
  check("a stalled transfer is dropped", stalling.size === 0);

  const rubbish = new BlobTransfer(1024, 4, 1000, () => 1000);
  check("a bad hash is refused", rubbish.accept("not a hash", 0, 1, "00").status === "rejected");
  check("odd hex is refused", rubbish.accept(pictureHash, 0, 1, "0").status === "rejected");
  check("a chunk past the end is refused", rubbish.accept(pictureHash, 9, 2, "00").status === "rejected");

  // The type a post declared for a blob is remembered.
  const mediaEvent = await draft(alice, "post", {
    text: "look",
    media: [{ hash, size: bytes.length, type: "image/png" }],
  });
  await store.ingest(mediaEvent);
  check("the type a post declared is kept", store.mediaType(hash) === "image/png");
  check("an unknown blob has no type", store.mediaType("f".repeat(64)) === null);

  // -------------------------------------------------------- subscriptions

  console.log("\nsubscriptions");

  store.setSubscriptions([alice.publicKey, bob.publicKey]);
  check("the subscription set is kept", store.subscriptions().length === 2);
  store.wantChain(carol.publicKey, "", 7);
  check("a head we do not hold is remembered", store.wanted()[0]?.seq === 7);
  check("the want can be found by key", store.wantFor(carol.publicKey, "")?.seq === 7);
  store.clearWant(carol.publicKey, "");
  check("a head we hold can be forgotten", store.wanted().length === 0);

  // A want is spent when the chain arrives. A want nobody answers is dropped.
  const carolHead = store.head(carol.publicKey, "");
  store.wantChain(carol.publicKey, "", carolHead?.seq ?? 0);
  store.clearSatisfiedWants();
  check("a chain that has arrived is no longer wanted", store.wanted().length === 0);

  store.wantChain(carol.publicKey, "", (carolHead?.seq ?? 0) + 50);
  await new Promise((resolve) => setTimeout(resolve, 5));
  store.expireWants(0);
  check("a chain nobody answers is not wanted for ever", store.wanted().length === 0);

  // --------------------------------------------------------- notifications

  console.log("\nnotifications");

  const aliceNotes = store.notifications(alice.publicKey);
  check("a follow notifies the person followed", aliceNotes.some((note) => note.kind === "follow"));
  check(
    "a reply notifies the person replied to",
    store.notifications(carol.publicKey).some((note) => note.kind === "reply"),
  );
  check("a reaction notifies the author", store.notifications(carol.publicKey).some((note) => note.kind === "reaction"));
  check("unread is counted", store.unread(alice.publicKey) > 0);
  store.markNotificationsRead(alice.publicKey);
  check("reading clears the count", store.unread(alice.publicKey) === 0);

  // ---------------------------------------------------------------- ranking

  console.log("\nranking");

  const context = {
    now: Date.now(),
    following: new Set([alice.publicKey]),
    me: bob.publicKey,
    muted: new Set<string>(),
  };
  const candidates = store.feed({}).top.map((post) => ({
    id: post.id,
    author: post.author,
    createdAt: post.createdAt,
    replyCount: post.replyCount,
    reactions: post.reactions,
    retracted: post.retracted,
    interacted: false,
  }));
  const ranked = rankFeed(candidates, context);
  check("ranking is deterministic", JSON.stringify(rankFeed(candidates, context)) === JSON.stringify(ranked));
  check(
    "a muted author is left out",
    !rankFeed(candidates, { ...context, muted: new Set([alice.publicKey]) }).some(
      (post) => post.author === alice.publicKey,
    ),
  );
  check("an empty feed ranks to nothing", rankFeed([], context).length === 0);

  // ------------------------------------------------------------------- wire

  console.log("\nwire");

  const peer = await generateKeyPair();
  const nonce = "ab".repeat(16);
  const peerSig = await signHello(peer.privateKey, peer.publicKey, "1.2.3.4:7331", nonce);
  check("a signed hello verifies", await verifyHello({ peer: peer.publicKey, addr: "1.2.3.4:7331", nonce, sig: peerSig }));
  check(
    "a hello with another address does not verify",
    !(await verifyHello({ peer: peer.publicKey, addr: "9.9.9.9:1", nonce, sig: peerSig })),
  );
  check(
    "a hello signed by another key does not verify",
    !(await verifyHello({
      peer: peer.publicKey,
      addr: "1.2.3.4:7331",
      nonce,
      sig: await signHello(bob.privateKey, bob.publicKey, "1.2.3.4:7331", nonce),
    })),
  );

  // The handshake is bound to the connection it happens on: the second hello
  // signs the nonce the other side sent, so a hello captured elsewhere cannot
  // be used to pass as that peer.
  const ourNonce = "cd".repeat(16);
  const theirNonce = "ef".repeat(16);
  const boundSig = await signHello(peer.privateKey, peer.publicKey, "1.2.3.4:7331", theirNonce, ourNonce);
  check(
    "a hello that signs our nonce verifies",
    await verifyHello({ peer: peer.publicKey, addr: "1.2.3.4:7331", nonce: theirNonce, peerNonce: ourNonce, sig: boundSig }),
  );
  check(
    "a hello that signs another nonce does not verify",
    !(await verifyHello({ peer: peer.publicKey, addr: "1.2.3.4:7331", nonce: theirNonce, peerNonce: "00".repeat(16), sig: boundSig })),
  );
  check(
    "an opening hello does not verify as a bound one",
    !(await verifyHello({ peer: peer.publicKey, addr: "1.2.3.4:7331", nonce: theirNonce, sig: boundSig })),
  );
  check(
    "a hello with no nonce at all is refused",
    !(await verifyHello({ peer: peer.publicKey, addr: "1.2.3.4:7331", nonce: "", sig: boundSig })),
  );

  const decoder = new FrameDecoder();
  const whole = decoder.push(encodeFrame({ t: "ping", at: 5 }) + encodeFrame({ t: "bye" }));
  check("frames arrive whole", whole.messages.length === 2);
  const half = decoder.push('{"t":"pi');
  check("a half frame is held", half.messages.length === 0);
  const rest = decoder.push('ng","at":9}\n');
  check("the rest arrives later", rest.messages.length === 1);
  check("junk is dropped, not fatal", decoder.push("not json\n").messages.length === 0);

  // The frame limit is about memory, so it is counted in bytes and checked
  // before the chunk is held.
  const small = new FrameDecoder(16);
  check(
    "a frame over the limit ends the stream",
    small.push(`${"x".repeat(64)}\n`).overflow,
  );
  const counting = new FrameDecoder(8);
  check("a frame of four bytes fits", !counting.push('{"a":1}\n').overflow);
  check("the limit is counted in bytes", utf8Length("€€") === 6, `${utf8Length("€€")}`);

  // ------------------------------------------------------------------ races

  console.log("\nraces");

  // Two copies of one event can arrive at the same moment: a peer may answer
  // the same request twice, and gossip has no idea what another node holds.
  // The append decides, not the check before it.
  const racer = await generateKeyPair();
  const raced = await createEvent(racer.privateKey, {
    author: racer.publicKey,
    seq: 0,
    prev: "",
    kind: "post",
    body: { text: "the same stone twice" },
  });
  const [firstCopy, secondCopy] = await Promise.all([store.ingest(raced), store.ingest(raced)]);
  check(
    "the same event twice at once is stored once",
    [firstCopy.status, secondCopy.status].includes("added") &&
      [firstCopy.status, secondCopy.status].includes("duplicate"),
    `${firstCopy.status}/${secondCopy.status}`,
  );

  // Two different events at the same seq are a fork, not a crash.
  const forkA = await createEvent(racer.privateKey, {
    author: racer.publicKey,
    seq: 0,
    prev: "",
    kind: "post",
    body: { text: "one way to be at seq zero" },
  });
  const forkB = await createEvent(racer.privateKey, {
    author: racer.publicKey,
    seq: 0,
    prev: "",
    kind: "post",
    body: { text: "another way to be at seq zero" },
  });
  const [forkOne, forkTwo] = await Promise.all([store.ingest(forkA), store.ingest(forkB)]);
  check(
    "two events at one seq, at once, do not crash the node",
    [forkOne.status, forkTwo.status].every((status) => status === "added" || status === "invalid"),
    `${forkOne.status}/${forkTwo.status}`,
  );
  check("the ledger is still whole", (await store.verifyAll()).ok);

  // ---------------------------------------------------------------- at rest

  console.log("\nat rest");

  const secret = "a phrase that must never be on the disk in the clear";
  await store.ingest(await draft(alice, "post", { text: secret }));

  let onDisk = "";
  for (const file of ["river.db", "river.db-wal", "river.db-shm"]) {
    try {
      onDisk += (await readFile(join(dir, file))).toString("latin1");
    } catch {
      /* the file may not exist */
    }
  }
  check("the words are not on the disk in the clear", !onDisk.includes(secret));
  check("the feed still shows them", store.feed({}).top.some((post) => post.text === secret));
  check("the log still verifies", (await store.verifyAll()).ok);

  await copyFile(join(dir, "river.db"), join(dir, "copy.db"));
  for (const suffix of ["-wal", "-shm"]) {
    try {
      await copyFile(join(dir, `river.db${suffix}`), join(dir, `copy.db${suffix}`));
    } catch {
      /* optional */
    }
  }
  const wrong = new Store(join(dir, "copy.db"), { dataKey: randomBytes(32) });
  check("the wrong key does not open the words", wrong.feed({}).top.every((post) => post.text === ""));
  check("the wrong key does not verify the log", !(await wrong.verifyAll()).ok);
  wrong.close();

  // -------------------------------------------------------------- migration

  console.log("\nmigration");

  const oldDir = join(tmpdir(), `river-old-${Date.now().toString(36)}`);
  mkdirSync(oldDir, { recursive: true });
  const oldFile = join(oldDir, "river.db");

  const raw = new DatabaseSync(oldFile);
  raw.exec(`
    CREATE TABLE events (
      id TEXT PRIMARY KEY, author TEXT NOT NULL, seq INTEGER NOT NULL, prev TEXT NOT NULL,
      kind TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, sig TEXT NOT NULL,
      received_at INTEGER NOT NULL, UNIQUE(author, seq)
    );
    CREATE TABLE heads (author TEXT PRIMARY KEY, seq INTEGER NOT NULL, id TEXT NOT NULL);
  `);
  raw
    .prepare(
      `INSERT INTO events (id, author, seq, prev, kind, body, created_at, sig, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      alicePost.id,
      alicePost.author,
      alicePost.seq,
      alicePost.prev,
      alicePost.kind,
      JSON.stringify(alicePost.body),
      alicePost.createdAt,
      alicePost.sig,
      Date.now(),
    );
  raw
    .prepare("INSERT INTO heads (author, seq, id) VALUES (?, ?, ?)")
    .run(alicePost.author, alicePost.seq, alicePost.id);
  raw.close();

  const migrated = new Store(oldFile, { dataKey: randomBytes(32) });
  check("an old log survives the migration", migrated.eventCount() === 1, `${migrated.eventCount()}`);
  check("an old head survives the migration", migrated.head(alice.publicKey, "")?.seq === 0);
  check("a migrated log still verifies", (await migrated.verifyAll()).ok);

  const rawAfterDb = new DatabaseSync(oldFile);
  const rawAfter = rawAfterDb
    .prepare("SELECT body FROM events")
    .get() as { body: string };
  check("an old log is sealed once a key is used", !rawAfter.body.includes("the first stone"));
  rawAfterDb.close();
  const movedSlot = migrated.nextSlot(alice.publicKey, "");
  const afterMove = await createEvent(alice.privateKey, {
    author: alice.publicKey,
    seq: movedSlot.seq,
    prev: movedSlot.prev,
    kind: "post",
    body: { text: "after the move" },
  });
  check(
    "a migrated log can take a new event",
    (await migrated.ingest(afterMove)).status === "added",
  );
  migrated.close();
  await rm(oldDir, { recursive: true, force: true });

  // ----------------------------------------------------------------- wallets

  console.log("\nwallets");

  const wallet = secp256k1.utils.randomSecretKey
    ? secp256k1.utils.randomSecretKey()
    : randomBytes(32);
  const walletPublic = secp256k1.getPublicKey(wallet, false);
  const walletAddress = addressFromPublicKey(walletPublic);

  check("a wallet has an address", ETH_ADDRESS.test(walletAddress), walletAddress);

  const message = randomBytes(32);
  const digest = personalSignDigest(message);
  // A wallet sends r || s || v; the recovery id is found by asking which
  // candidate lifts back to the address.
  const full = walletSignature(digest, wallet, walletAddress);

  check(
    "a wallet signature recovers to its address",
    recoverAddress(digest, full) === walletAddress,
  );
  check(
    "a signature from another key recovers elsewhere",
    recoverAddress(digest, new Uint8Array(65)) !== walletAddress,
  );
  check(
    "a personal signature verifies against the address",
    verifyPersonalSignature(walletAddress, message, full),
  );
  check(
    "a personal signature does not verify against another address",
    !verifyPersonalSignature(`0x${"11".repeat(20)}`, message, full),
  );

  // an event written by a wallet
  const walletSlot = store.nextSlot(walletAddress, "");
  const walletEvent = await createEthEvent(
    wallet,
    walletAddress,
    walletSlot.seq,
    walletSlot.prev,
    "post",
    { text: "signed by a wallet" },
  );
  check("a wallet event has an address for an author", walletEvent.author === walletAddress);
  check("a wallet event verifies", await verifyEvent(walletEvent));
  check("a wallet event is accepted", (await store.ingest(walletEvent)).status === "added");
  check("the wallet's post is in the feed", store.feed({}).top.some((post) => post.text === "signed by a wallet"));
  const walletReport = await store.verifyAll();
  check(
    "the whole ledger still verifies",
    walletReport.ok,
    walletReport.errors[0]?.detail ?? "",
  );

  const tamperedWallet = { ...walletEvent, body: { text: "signed by somebody else" } };
  check("a rewritten wallet event does not verify", !(await verifyEvent(tamperedWallet)));

  // sign in
  const statement = formatSiwe({
    domain: "river",
    address: walletAddress,
    statement: "Sign in to River.",
    nonce: "0011223344556677",
  });
  const statementDigest = personalSignDigest(new TextEncoder().encode(statement));
  const statementFull = walletSignature(statementDigest, wallet, walletAddress);
  const signedIn = verifySiwe(statement, statementFull);
  check("a sign-in statement verifies", signedIn?.address === walletAddress);
  check("a sign-in statement carries its nonce", signedIn?.nonce === "0011223344556677");

  const wrongStatement = formatSiwe({
    domain: "river",
    address: walletAddress,
    statement: "Sign in to River.",
    nonce: "ffffffffffffffff",
  });
  check(
    "a statement signed for another nonce does not verify",
    verifySiwe(wrongStatement, statementFull) === null,
  );

  store.close();
  await rm(dir, { recursive: true, force: true });

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\n  FAIL", error.message, "\n", error.stack, "\n");
  process.exit(1);
});
