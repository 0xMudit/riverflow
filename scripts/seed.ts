/**
 * A hundred strangers, and everything they said.
 *
 *   npm run seed                       # 100 users, seeded into ./data/seed
 *   npx tsx scripts/seed.ts --count 250 --days 30 --peers 127.0.0.1:7331
 *
 * Nothing here is a mock. Every user is given a real ed25519 key, and every
 * event they write is signed and chained exactly the way a person's own
 * words are signed and chained: the profile is seq 0, the first post is seq 1,
 * and each event names the one before it. The node that holds these logs
 * gossips them to the network like any other node, and any peer that receives
 * them verifies them the same way it verifies anybody's.
 *
 * The names and the words come from faker. The chain does not.
 */
import { join } from "node:path";
import { faker } from "@faker-js/faker";
import { RiverNode } from "../src/main/node";
import { createEvent } from "../src/core/events";
import { generateKeyPair, type KeyPair } from "../src/core/crypto";
import type { Event, EventBody, EventKind } from "../src/core/types";

function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

const flag = (name: string) => process.argv.includes(`--${name}`);

/** One person on the network, and the tail of their log. */
interface SeedUser {
  keys: KeyPair;
  name: string;
  /** the next free seq in this person's log */
  seq: number;
  /** the id of the event before it */
  prev: string;
  /** the posts this person wrote, so others can reply to them */
  posts: string[];
}

const RIPPLES = ["≈", "🔥", "✳", "◦", "≈"];

async function main() {
  const count = Math.max(1, Number(arg("count", "100")));
  const days = Math.max(1, Number(arg("days", "21")));
  const dataDir = arg("data", join(process.cwd(), "data", "seed"));
  const port = Number(arg("port", "7401"));
  const peers = arg("peers", "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const seed = arg("seed", "");
  if (seed) faker.seed(Number(seed));

  const node = new RiverNode({
    dataDir,
    port,
    discovery: false,
    log: (line) => console.log(`[seed] ${line}`),
  });
  await node.start();

  const now = Date.now();
  const users: SeedUser[] = [];
  for (let index = 0; index < count; index++) {
    const first = faker.person.firstName();
    const last = faker.person.lastName();
    users.push({
      keys: await generateKeyPair(),
      name: `${first} ${last}`,
      seq: 0,
      prev: "",
      posts: [],
    });
  }

  /** Write one event on a person's chain, and keep the chain in step. */
  const write = async (
    user: SeedUser,
    kind: EventKind,
    body: EventBody,
    createdAt: number,
  ): Promise<Event> => {
    const event = await createEvent(
      user.keys.privateKey,
      { author: user.keys.publicKey, seq: user.seq, prev: user.prev, kind, body },
      createdAt,
    );
    const result = await node.store.ingest(event);
    if (result.status !== "added") {
      throw new Error(`could not seed a ${kind}: ${result.reason ?? result.status}`);
    }
    user.seq += 1;
    user.prev = event.id;
    return event;
  };

  /** A moment in the past, so the ledger's clock is never in the future. */
  const clock = (base: number, step: number): number => {
    const gap = faker.number.int({ min: 90_000, max: 9 * 60 * 60 * 1000 });
    return Math.min(now - 1_000, base + step * gap);
  };

  /** Somebody else's post, chosen at random. */
  const otherPost = (from: SeedUser): { id: string; author: string } | null => {
    const choices = users.filter((user) => user !== from && user.posts.length > 0);
    if (choices.length === 0) return null;
    const author = faker.helpers.arrayElement(choices);
    return { id: faker.helpers.arrayElement(author.posts), author: author.keys.publicKey };
  };

  const otherAuthor = (from: SeedUser): string | null => {
    const choices = users.filter((user) => user !== from);
    if (choices.length === 0) return null;
    return faker.helpers.arrayElement(choices).keys.publicKey;
  };

  // ---------------------------------------------------------------- profiles

  console.log(`\nseeding ${count} people…`);

  for (const user of users) {
    const base = now - faker.number.int({ min: 1, max: days }) * 86_400_000;
    await write(
      user,
      "profile",
      {
        name: user.name,
        bio: faker.lorem.sentence({ min: 4, max: 14 }),
        hue: faker.number.int({ min: 0, max: 359 }),
      },
      clock(base, 0),
    );
  }

  // ------------------------------------------------------------------ posts

  for (const user of users) {
    const base = now - faker.number.int({ min: 1, max: days }) * 86_400_000;
    const posts = faker.number.int({ min: 1, max: 6 });
    for (let index = 0; index < posts; index++) {
      const event = await write(
        user,
        "post",
        { text: faker.lorem.sentence({ min: 5, max: 18 }) },
        clock(base, index + 1),
      );
      user.posts.push(event.id);
    }
  }

  // ---------------------------------------------------------------- replies

  for (const user of users) {
    const base = now - faker.number.int({ min: 0, max: Math.max(1, days - 1) }) * 86_400_000;
    const replies = faker.number.int({ min: 0, max: 3 });
    for (let index = 0; index < replies; index++) {
      const target = otherPost(user);
      if (!target) break;
      await write(
        user,
        "post",
        { text: faker.lorem.sentence({ min: 4, max: 16 }), replyTo: target.id },
        clock(base, index + 1),
      );
    }
  }

  // ------------------------------------------------------- ripples, follows

  for (const user of users) {
    const base = now - faker.number.int({ min: 0, max: Math.max(1, days - 1) }) * 86_400_000;
    const ripples = faker.number.int({ min: 0, max: 5 });
    for (let index = 0; index < ripples; index++) {
      const target = otherPost(user);
      if (!target) break;
      await write(
        user,
        "reaction",
        { target: target.id, emoji: faker.helpers.arrayElement(RIPPLES) },
        clock(base, index + 1),
      );
    }

    const follows = faker.number.int({ min: 0, max: 4 });
    for (let index = 0; index < follows; index++) {
      const target = otherAuthor(user);
      if (!target) break;
      await write(user, "follow", { target }, clock(base, ripples + index + 1));
    }
  }

  // ----------------------------------------------------------------- report

  const stats = node.store.stats();
  const report = await node.verify();
  console.log(
    `\n  ${stats.authors} chains · ${stats.events} events · ${stats.posts} posts · ` +
      `${stats.follows} follows · ${stats.reactions} ripples`,
  );
  console.log(
    `  the ledger verifies: ${report.ok ? "yes" : "no"} (${report.events} events in ${report.durationMs}ms)`,
  );
  if (!report.ok) {
    console.error(`  ${report.errors[0]?.detail ?? "the chains do not hold"}`);
  }

  const feed = node.store.feed({ limit: 5 });
  console.log("\n  what the river looks like now:");
  for (const post of feed.top) {
    const author = node.store.profile(post.author)?.name ?? "someone";
    console.log(`    ${author}: ${post.text.slice(0, 64)}`);
  }

  for (const address of peers) {
    try {
      await node.dial(address);
      console.log(`  dialled ${address}`);
    } catch (error) {
      console.log(`  could not reach ${address}: ${(error as Error).message}`);
    }
  }

  console.log(`\n  this node is listening on ${node.server.address()}`);
  console.log(`  seed it again with --seed <number> to get the same hundred people back.\n`);

  if (flag("exit")) {
    await node.stop();
    return;
  }

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
