/**
 * Seed ledger — the river should not open empty.
 *
 * These three identities are demo citizens with fixed keys, so the first boot
 * of any machine produces the same opening history. Their private keys are
 * public knowledge on purpose: they are scenery, not accounts. Never put a key
 * that matters in this file.
 */
import { createEvent } from "./events";
import { publicKeyOf } from "./crypto";
import type { RiverEvent } from "./types";

const SEEDS = {
  river: "01".repeat(32),
  mira: "02".repeat(32),
  kestrel: "03".repeat(32),
} as const;

export interface SeedEvent {
  event: RiverEvent;
  /** minutes before "now" at first boot, so the opening day reads naturally */
  minutesAgo: number;
}

export async function seedEvents(): Promise<SeedEvent[]> {
  const keys = {
    river: await publicKeyOf(SEEDS.river),
    mira: await publicKeyOf(SEEDS.mira),
    kestrel: await publicKeyOf(SEEDS.kestrel),
  } as const;

  const out: SeedEvent[] = [];
  const push = (event: RiverEvent, minutesAgo: number) => out.push({ event, minutesAgo });
  const at = (minutesAgo: number) => Date.now() - minutesAgo * 60_000;

  push(
    await createEvent(SEEDS.river, keys.river, "profile", {
      name: "river",
      bio: "the bed remembers",
      hue: 178,
    }, at(420)),
    420,
  );
  push(
    await createEvent(SEEDS.mira, keys.mira, "profile", {
      name: "mira",
      bio: "building small tools, slowly",
      hue: 318,
    }, at(400)),
    400,
  );
  push(
    await createEvent(SEEDS.kestrel, keys.kestrel, "profile", {
      name: "kestrel",
      bio: "temporarily here",
      hue: 42,
    }, at(380)),
    380,
  );

  const welcome = await createEvent(SEEDS.river, keys.river, "post", {
    text:
      "This river has no drain.\n\nWhat you drop here settles into the bed and stays. " +
      "Edit if you must — an edit is a new stone laid on top, not a replacement. " +
      "There is no delete button, because the ledger is the place, and the place remembers.",
  }, at(300));
  push(welcome, 300);

  push(
    await createEvent(SEEDS.mira, keys.mira, "post", {
      text:
        "First day. The thing I keep turning over: the missing delete button changed what I typed. " +
        "Not dramatically. I just stopped writing things I didn't mean.",
    }, at(240)),
    240,
  );

  const test = await createEvent(SEEDS.kestrel, keys.kestrel, "post", {
    text: "testing whether this is actually immutable or just says so",
  }, at(180));
  push(test, 180);

  push(
    await createEvent(SEEDS.river, keys.river, "post", {
      text:
        "Both. Retract it and watch — the retraction will be a block too, and your words stay underneath it.",
      replyTo: test.id,
    }, at(175)),
    175,
  );

  push(
    await createEvent(SEEDS.kestrel, keys.kestrel, "retract", {
      target: test.id,
      reason: "it was a test. leaving it as silt.",
    }, at(120)),
    120,
  );

  push(await createEvent(SEEDS.mira, keys.mira, "follow", { target: keys.river }, at(100)), 100);
  push(await createEvent(SEEDS.kestrel, keys.kestrel, "follow", { target: keys.mira }, at(90)), 90);
  push(await createEvent(SEEDS.river, keys.river, "follow", { target: keys.mira }, at(80)), 80);
  push(
    await createEvent(SEEDS.mira, keys.mira, "reaction", { target: welcome.id, emoji: "≈" }, at(70)),
    70,
  );

  return out;
}
