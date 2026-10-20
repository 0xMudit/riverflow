/**
 * Storage: a single append-only file, one JSON block per line.
 *
 * The file *is* the chain. There is no index, no schema migration, no update
 * path, and no delete path — the only write this module performs is `append`.
 * On boot the file is replayed from line one, so the process can crash at any
 * moment and lose nothing.
 */
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { genesisBlock, mineBlock } from "./chain";
import { seedEvents } from "./seed";
import type { Block, RiverEvent } from "./types";

const DATA_DIR = path.join(process.cwd(), "data");
const LEDGER_FILE = path.join(DATA_DIR, "chain.jsonl");

export class Ledger {
  private blocks: Block[] = [];
  private ready: Promise<void> | null = null;
  /** serialises appends so two concurrent requests cannot mine the same height */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file = LEDGER_FILE) {}

  async load(): Promise<void> {
    if (!this.ready) {
      this.ready = this.bootstrap().catch((error) => {
        this.ready = null;
        throw error;
      });
    }
    return this.ready;
  }

  private async bootstrap(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });

    let raw = "";
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const lines = raw.split("\n").filter((line) => line.trim().length > 0);

    if (lines.length === 0) {
      this.blocks = [await genesisBlock()];
      await this.writeLine(this.blocks[0]);
      await this.seed();
      return;
    }

    const parsed: Block[] = [];
    for (const [i, line] of lines.entries()) {
      try {
        parsed.push(JSON.parse(line) as Block);
      } catch {
        // Refuse to guess. A torn line means the ledger needs a human.
        throw new Error(
          `Ledger is unreadable at line ${i + 1} of ${this.file}. Refusing to continue rather than silently drop history.`,
        );
      }
    }
    this.blocks = parsed;
  }

  private async seed(): Promise<void> {
    const seeds = await seedEvents();
    for (const { event, minutesAgo } of seeds) {
      await this.commit([event], Date.now() - minutesAgo * 60_000);
    }
  }

  private async writeLine(block: Block): Promise<void> {
    // One append, one syscall: the file only ever grows at the end.
    const handle = await open(this.file, "a");
    try {
      await handle.appendFile(`${JSON.stringify(block)}\n`, "utf8");
    } finally {
      await handle.close();
    }
  }

  /** Mine and persist one block. Never rewrites an existing byte. */
  private async commit(events: RiverEvent[], timestamp?: number): Promise<Block> {
    const prev = this.blocks[this.blocks.length - 1];
    const block = await mineBlock(prev, events, undefined, timestamp);
    await this.writeLine(block);
    this.blocks.push(block);
    return block;
  }

  async append(events: RiverEvent[]): Promise<Block> {
    const run = this.queue.then(() => this.commit(events));
    // Keep the queue alive even if this caller rejects.
    this.queue = run.catch(() => undefined);
    return run;
  }

  snapshot(): Block[] {
    return this.blocks;
  }

  head(): Block {
    return this.blocks[this.blocks.length - 1];
  }

  get height(): number {
    return this.blocks.length - 1;
  }
}

const globalForLedger = globalThis as unknown as { __riverLedger?: Ledger };

/** One ledger per process, surviving dev-mode hot reloads. */
export function ledger(): Ledger {
  globalForLedger.__riverLedger ??= new Ledger();
  return globalForLedger.__riverLedger;
}

export const LEDGER_PATH = LEDGER_FILE;
