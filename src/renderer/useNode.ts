import { useCallback, useEffect, useState } from "react";
import type { BootStatus, IdentityInfo } from "@/core/bridge";
import type { Event, EventBody, EventKind, Snapshot } from "@/core/types";

export type PublishFn = (kind: EventKind, body: EventBody, device?: string) => Promise<Event>;

/**
 * The window's whole view of the world: whatever the local node says, re-read
 * on every change it announces. There is no client-side cache of the truth.
 */
export function useNode(includeSilt: boolean) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [identity, setIdentity] = useState<IdentityInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [boot, setBoot] = useState<BootStatus | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await window.river.snapshot(includeSilt);
      setSnapshot(next);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "the local node did not answer");
      void window.river
        .bootStatus()
        .then(setBoot)
        .catch(() => undefined);
    }
  }, [includeSilt]);

  useEffect(() => {
    let alive = true;
    void refresh();
    void window.river
      .identity()
      .then((info) => alive && setIdentity(info))
      .catch(() => undefined);

    const off = window.river.onUpdate(() => void refresh());
    // Peers update their "last seen" without emitting events, so poll gently.
    const timer = window.setInterval(() => void refresh(), 6000);

    return () => {
      alive = false;
      off();
      window.clearInterval(timer);
    };
  }, [refresh]);

  const publish = useCallback<PublishFn>(
    async (kind, body, device) => {
      // A device writes on its own chain, under the person's authority.
      const event = device
        ? await window.river.publishAs(kind, body, device)
        : await window.river.publish(kind, body);
      await refresh();
      return event;
    },
    [refresh],
  );

  return { snapshot, identity, error, boot, refresh, publish };
}
