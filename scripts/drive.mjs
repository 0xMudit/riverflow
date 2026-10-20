/**
 * Drive the real desktop app: claim a name, write a few posts, bring a second
 * node online, and photograph the result. This is a QA harness, not a mock.
 *
 *   node scripts/drive.mjs
 */
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { _electron as electron } from "playwright-core";

const POSTS = [
  "A social network where nothing is deleted. Not hidden, not archived — still there, verifiable, forever.",
  "No server. No owner. Your key signs your words, and every event carries the hash of the one before it.",
  "A retraction here is not an eraser. It is a stone laid on top of the words — the current moves on, the riverbed keeps everything.",
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  await mkdir("shots", { recursive: true });

  const app = await electron.launch({ args: ["."], cwd: process.cwd() });
  const page = await app.firstWindow();
  await page.waitForSelector(".shell", { timeout: 40000 });
  await sleep(1200);

  const claim = page.getByRole("button", { name: "Claim a name" });
  if (await claim.count()) {
    await claim.click();
    await page.getByPlaceholder("name").fill("mudit");
    await page.getByPlaceholder("bio (optional)").fill("building a river that cannot be drained");
    await page.getByRole("button", { name: "Sign", exact: true }).click();
    await sleep(1400);
  }

  const composer = page.getByLabel("Write a post").first();
  for (const text of POSTS) {
    const already = await page.getByText(text.slice(0, 40)).count();
    if (already > 0) continue;
    await composer.fill(text);
    await page.getByRole("button", { name: "Sign & seal" }).first().click();
    await sleep(1100);
  }

  await page.screenshot({ path: "shots/01-river.png" });

  const peer = spawn(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["tsx", "scripts/peer.ts", "--name", "mira", "--port", "7400", "--peers", "127.0.0.1:7331", "--demo"],
    { cwd: process.cwd(), stdio: "inherit", shell: process.platform === "win32" },
  );

  try {
    await page.waitForSelector("text=Crossed over from a second node", { timeout: 90000 });
    await sleep(2500);
    await page.screenshot({ path: "shots/02-with-peer.png" });

    const silts = page.getByRole("button", { name: /^silt/ });
    if (await silts.count()) {
      await silts.first().click();
      await sleep(700);
    }
    await page
      .getByRole("button", { name: "reveal the original" })
      .first()
      .click({ timeout: 5000 })
      .catch(() => undefined);
    await sleep(500);
    await page.screenshot({ path: "shots/03-silt.png" });

    await page.getByRole("button", { name: "The network" }).click();
    await sleep(900);
    await page.getByRole("button", { name: "Verify everything" }).click();
    await sleep(1800);
    await page.screenshot({ path: "shots/04-network.png" });

    await page.getByRole("button", { name: "Try to erase an event" }).click();
    await sleep(1400);
    await page.screenshot({ path: "shots/05-breach.png" });
  } finally {
    peer.kill();
    await sleep(400);
    await app.close();
  }

  console.log("\nscreenshots written to shots/\n");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
