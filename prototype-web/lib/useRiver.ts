"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { verifyChain } from "./river/chain";
import { createEvent } from "./river/events";
import { ensureIdentity, type Identity } from "./river/identity";
import { project, type RiverState } from "./river/project";
import type { Block, EventBody, EventKind, VerificationReport } from "./river/types";

export interface RiverData {
  blocks: Block[];
  state: RiverState;
  report: VerificationReport;
  fetchedAt: number;
}

export interface SealedBlock {
  index: number;
  hash: string;
  nonce: number;
}

export interface RiverApi {
  data: RiverData | null;
  identity: Identity | null;
  error: string | null;
  posting: boolean;
  refresh: () => Promise<void>;
  submit: (kind: EventKind, body: EventBody) => Promise<SealedBlock>;
}

/**
 * One hook, one job: pull the ledger, verify it *in the browser*, and fold it
 * into view state. The server is never trusted for what it sends — only the
 * signatures and hashes are believed.
 */
export function useRiver(pollMs = 5000): RiverApi {
  const [data, setData] = useState<RiverData | null>(null);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);

  const signatureCache = useRef(new Map<string, boolean>());
  const inFlight = useRef(false);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const response = await fetch("/api/chain", { cache: "no-store" });
      if (!response.ok) throw new Error(`ledger fetch failed (${response.status})`);
      const payload = (await response.json()) as { blocks: Block[] };
      const report = await verifyChain(payload.blocks, { cache: signatureCache.current });
      if (!mounted.current) return;
      setData({
        blocks: payload.blocks,
        report,
        state: project(payload.blocks, report.eventValidity),
        fetchedAt: Date.now(),
      });
      setError(null);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "could not reach the ledger");
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void ensureIdentity().then((id) => mounted.current && setIdentity(id));
    void refresh();
    const timer = window.setInterval(() => void refresh(), pollMs);
    const onIdentity = () => {
      void ensureIdentity().then((id) => mounted.current && setIdentity(id));
    };
    window.addEventListener("river:identity", onIdentity);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
      window.removeEventListener("river:identity", onIdentity);
    };
  }, [refresh, pollMs]);

  const submit = useCallback(
    async (kind: EventKind, body: EventBody) => {
      setPosting(true);
      try {
        const me = identity ?? (await ensureIdentity());
        const event = await createEvent(me.privateKey, me.publicKey, kind, body);
        const response = await fetch("/api/events", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ event }),
        });
        const payload = (await response.json()) as {
          error?: string;
          block?: SealedBlock;
        };
        if (!response.ok || !payload.block) {
          throw new Error(payload.error ?? "the river refused this event");
        }
        await refresh();
        return payload.block;
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "could not sign that event";
        setError(message);
        throw new Error(message);
      } finally {
        if (mounted.current) setPosting(false);
      }
    },
    [identity, refresh],
  );

  return { data, identity, error, posting, refresh, submit };
}
