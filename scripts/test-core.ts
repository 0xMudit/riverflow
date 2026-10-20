/**
 * Unit tests for the ledger rules. No network, no UI — just the invariants that
 * make "nothing is deleted" mean something.
 *
 *   npm test
 */
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, sign, type KeyPair } from "../src/core/crypto";
import { fromHex } from "../src/core/canonical";
import { createEvent, eventId } from "../src/core/events";
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

  store.close();
  await rm(dir, { recursive: true, force: true });

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\n  FAIL", error.message, "\n");
  process.exit(1);
});
