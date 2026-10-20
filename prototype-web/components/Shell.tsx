"use client";

import type { ReactNode } from "react";
import { LeftRail } from "@/components/LeftRail";
import { RightRail } from "@/components/RightRail";
import type { Identity } from "@/lib/river/identity";
import type { RiverState } from "@/lib/river/project";
import type { Block, EventBody, EventKind, VerificationReport } from "@/lib/river/types";

export type SubmitFn = (kind: EventKind, body: EventBody) => Promise<{ index: number }>;

/** Three columns, one ledger. Used by the feed, profiles and the explorer. */
export function Shell({
  children,
  state,
  report,
  blocks,
  identity,
  submit,
  notify,
}: {
  children: ReactNode;
  state: RiverState | null;
  report: VerificationReport | null;
  blocks: Block[];
  identity: Identity | null;
  submit: SubmitFn;
  notify: (message: string) => void;
}) {
  return (
    <div className="shell">
      <LeftRail state={state} identity={identity} submit={submit} notify={notify} />
      <main className="feed-col">
        <div className="current" />
        {children}
      </main>
      <RightRail
        state={state}
        report={report}
        blocks={blocks}
        identity={identity}
        submit={submit}
        notify={notify}
      />
    </div>
  );
}
