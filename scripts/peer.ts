/**
 * A second human, for testing.
 *
 *   npx tsx scripts/peer.ts --name mira --port 7400 --peers 127.0.0.1:7331 --demo
 *
 * Runs a real node with its own key and log in ./data/<name>, joins the network
 * and (with --demo) writes a small, honest history: a name, a few posts, one
 * retraction, a reply and a follow.
 */
import { join } from "node:path";
import { RiverNode } from "../src/main/node";
import type { PostView } from "../src/core/types";

function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

const flag = (name: string) => process.argv.includes(`--${name}`);

async function waitFor(what: string, predicate: () => boolean, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function main() {
  const name = arg("name", "mira");
  const port = Number(arg("port", "7400"));
  const peers = arg("peers", "127.0.0.1:7331")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const node = new RiverNode({
    dataDir: join(process.cwd(), "data", name),
    port,
    discovery: true,
    log: (line) => console.log(`[${name}] ${line}`),
  });

  await node.start();

  for (const address of peers) {
    try {
      await node.dial(address);
    } catch (error) {
      console.log(`[${name}] could not reach ${address}: ${(error as Error).message}`);
    }
  }

  const me = node.identity.publicKey;
  if (!node.store.profile(me)) {
    await node.publish("profile", {
      name,
      bio: "on the other bank",
      hue: name === "mira" ? 28 : 198,
    });
  }

  if (flag("demo") && node.store.postsByAuthor(me).length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 600));

    await node.publish("post", {
      text: "Crossed over from a second node. My log is mine, and it only grows.",
    });
    await new Promise((resolve) => setTimeout(resolve, 900));

    const retracted = await node.publish("post", {
      text: "this was a test post, gone in a moment",
    });
    await new Promise((resolve) => setTimeout(resolve, 700));
    await node.publish("retract", { target: retracted.id, reason: "served its purpose" });

    try {
      await waitFor(
        "a post from another node",
        () => node.store.feed({}).top.some((post: PostView) => post.author !== me),
        25000,
      );
      const target = node.store.feed({}).top.find((post: PostView) => post.author !== me);
      if (target) {
        await new Promise((resolve) => setTimeout(resolve, 800));
        await node.publish("post", {
          text: "A reply that travelled over TCP, signed on this machine and verified on yours.",
          replyTo: target.id,
        });
        await node.publish("follow", { target: target.author });
        await node.publish("reaction", { target: target.id, emoji: "≈" });
      }
    } catch {
      console.log(`[${name}] nobody else posted yet; staying online`);
    }
  }

  console.log(`[${name}] online as ${me.slice(0, 12)}… on port ${node.server.listenPort}`);

  const shutdown = async () => {
    await node.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await new Promise(() => undefined);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
