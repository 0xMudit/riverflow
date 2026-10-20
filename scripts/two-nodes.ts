/**
 * Two Rivers — an end-to-end proof with no UI, no server and no shortcuts.
 *
 *   node A  ──dial──▶  node B
 *   A posts, B syncs, B replies, A retracts.
 *   Both describe the same history, and neither can drop a byte of it.
 */
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RiverNode } from "../src/main/node";

const quiet = (...args: unknown[]) => console.log("  ", ...args);

function expect(condition: unknown, message: string) {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

async function waitFor(what: string, predicate: () => boolean, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return Date.now() - started;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function main() {
  const root = join(tmpdir(), `river-two-${Date.now().toString(36)}`);
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);

  const a = new RiverNode({ dataDir: join(root, "a"), port: 0, discovery: false, log });
  const b = new RiverNode({ dataDir: join(root, "b"), port: 0, discovery: false, log });

  try {
    await a.start();
    await b.start();
    quiet("node A", a.nodeId, "port", a.server.listenPort);
    quiet("node B", b.nodeId, "port", b.server.listenPort);

    // 1. A writes a profile and a post, offline. Nothing needs a server.
    await a.publish("profile", { name: "ada", bio: "writes things down", hue: 168 });
    const firstPost = await a.publish("post", { text: "first light on the river" });
    quiet("A wrote 2 events, alone:", a.store.stats().events);

    // 2. B dials A and catches up.
    const t0 = Date.now();
    await b.dial(`127.0.0.1:${a.server.listenPort}`);
    const syncMs = await waitFor("B to reach A's head", () => {
      const head = b.store.head(a.identity.publicKey);
      return head?.seq === 1;
    });
    quiet(`B synced A's log in ${Date.now() - t0}ms (poll ${syncMs}ms)`);
    expect(b.store.stats().events === 2, "B holds both of A's events");
    expect(b.snapshot().posts.length === 1, "B shows A's post in the feed");
    expect(b.snapshot().profiles[a.identity.publicKey]?.name === "ada", "B resolved A's name");

    // 3. B replies. The reply travels back over the same connection.
    const reply = await b.publish("post", { text: "and a reply from the other bank", replyTo: firstPost.id });
    await waitFor("A to receive B's reply", () => a.store.head(b.identity.publicKey)?.seq === 0);
    quiet("A received B's reply:", reply.id.slice(0, 10) + "…");
    expect(a.store.stats().events === 3, "A now holds three events");

    // 4. A retracts its post. Nothing is deleted; both nodes mark silt.
    await a.publish("retract", { target: firstPost.id, reason: "kept as silt" });
    await waitFor("B to see the retraction", () => {
      const post = b.store.feed({ includeSilt: true }).top.find((p) => p.id === firstPost.id);
      return Boolean(post?.retracted);
    });
    quiet("B sees the post as retracted, text still stored");

    // 5. Both nodes independently verify every signature and every link.
    const [va, vb] = await Promise.all([a.verify(), b.verify()]);
    quiet(`A verified ${va.events} events in ${va.durationMs}ms · ok=${va.ok}`);
    quiet(`B verified ${vb.events} events in ${vb.durationMs}ms · ok=${vb.ok}`);
    expect(va.ok && vb.ok, "both logs verify");
    expect(va.events === 4 && vb.events === 4, "both nodes hold the same four events");

    // 6. A peer view exists on both sides.
    expect(a.peerViews().length === 1 && b.peerViews().length === 1, "each node sees exactly one peer");
    quiet("peers:", a.peerViews().map((p) => `${p.id}/${p.direction}`).join(", "));

    // 7. The retracted text is gone from the flow but present in the log.
    expect(b.snapshot().posts.length === 0, "retracted posts leave the flow");
    expect(b.snapshot(true).posts.length === 1, "silt is still reachable on request");
    expect(
      b.store.eventsFor(a.identity.publicKey, 10).some((e) => e.kind === "post"),
      "the original post is still in A's log",
    );

    console.log("\n  ✓ two nodes, one history. Nothing was deleted.\n");
  } finally {
    await a.stop();
    await b.stop();
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("\n  ✗", error.message, "\n");
  process.exit(1);
});
