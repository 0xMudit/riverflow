/**
 * Unit tests for the ledger rules. No network, no UI — just the invariants that
 * make "nothing is deleted" mean something.
 *
 *   npm test
 */
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, sign, verify, type KeyPair } from "../src/core/crypto";
import { fromHex, toHex } from "../src/core/canonical";
import { createEvent, eventId } from "../src/core/events";
import { blobHash, chunkBytes, joinChunks, verifyBlob } from "../src/core/blobs";
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
import { encodeFrame, FrameDecoder, signHello, verifyHello } from "../src/core/wire";
import type { Event, EventBody, EventKind } from "../src/core/types";
import { Store } from "../src/main/store";

let passed = 0;
let failed = 0;

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
  const store = new Store(join(dir, "river.db"));
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

  // -------------------------------------------------------- subscriptions

  console.log("\nsubscriptions");

  store.setSubscriptions([alice.publicKey, bob.publicKey]);
  check("the subscription set is kept", store.subscriptions().length === 2);
  store.wantChain(carol.publicKey, "", 7);
  check("a head we do not hold is remembered", store.wanted()[0]?.seq === 7);
  store.clearWant(carol.publicKey, "");
  check("a head we hold can be forgotten", store.wanted().length === 0);

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

  const decoder = new FrameDecoder();
  const whole = decoder.push(encodeFrame({ t: "ping", at: 5 }) + encodeFrame({ t: "bye" }));
  check("frames arrive whole", whole.messages.length === 2);
  const half = decoder.push('{"t":"pi');
  check("a half frame is held", half.messages.length === 0);
  const rest = decoder.push('ng","at":9}\n');
  check("the rest arrives later", rest.messages.length === 1);
  check("junk is dropped, not fatal", decoder.push("not json\n").messages.length === 0);

  store.close();
  await rm(dir, { recursive: true, force: true });

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\n  FAIL", error.message, "\n");
  process.exit(1);
});
