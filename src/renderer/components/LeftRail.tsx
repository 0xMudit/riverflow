import { useState } from "react";
import { Home, Users, User, Search } from "lucide-react";
import type { IdentityInfo } from "@/core/bridge";
import type { Snapshot } from "@/core/types";
import { shortAddr } from "../format";
import { Avatar } from "./Avatar";
import type { View } from "../App";
import type { PublishFn } from "../useNode";
import { Input } from "@/ui/input";
import { cn } from "@/lib/utils";

function NavItem({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: typeof Home;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={cn(
        "flex items-center gap-3 rounded-full px-3 py-2.5 text-[15px] transition-colors",
        active ? "font-semibold text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
      onClick={onClick}
    >
      <Icon className={cn("size-5", active && "text-primary")} />
      {label}
    </button>
  );
}

export function LeftRail({
  snapshot,
  identity,
  view,
  onNavigate,
  publish,
  notify,
  query,
  onSearch,
}: {
  snapshot: Snapshot;
  identity: IdentityInfo;
  view: View;
  onNavigate: (view: View) => void;
  publish: PublishFn;
  notify: (message: string) => void;
  query: string;
  onSearch: (query: string) => void;
}) {
  const me = snapshot.me;
  const named = Boolean(snapshot.profiles[me?.pubkey ?? ""]);
  const peers = snapshot.peers.length;

  return (
    <aside className="sticky top-0 flex h-screen w-[248px] shrink-0 flex-col px-2 py-4">
      <button
        className="wordmark self-start px-3 text-[26px] leading-none"
        onClick={() => onNavigate({ name: "river" })}
      >
        River<em>.</em>
      </button>

      <nav className="mt-7 flex flex-col gap-0.5">
        <NavItem
          icon={Home}
          label="The river"
          active={view.name === "river"}
          onClick={() => onNavigate({ name: "river" })}
        />
        <NavItem
          icon={Users}
          label="The network"
          active={view.name === "network"}
          onClick={() => onNavigate({ name: "network" })}
        />
        <NavItem
          icon={User}
          label="You"
          active={view.name === "you"}
          onClick={() => onNavigate({ name: "you" })}
        />
      </nav>

      <div className="mt-4 px-1">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => onSearch(event.target.value)}
            placeholder="Search"
            aria-label="Search posts"
            className="h-10 rounded-full border-border/70 bg-card/40 pl-9"
          />
        </div>
      </div>

      <div className="mt-auto px-1">
        <button
          className="flex w-full items-center gap-2.5 rounded-full p-2 text-left transition-colors hover:bg-accent"
          onClick={() => onNavigate({ name: "you" })}
        >
          <Avatar name={me?.name ?? "you"} hue={me?.hue ?? 200} size="md" title={identity.publicKey} />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{named ? me?.name : "Your name"}</div>
            <div className="truncate text-xs text-muted-foreground">{shortAddr(identity.publicKey)}</div>
          </div>
        </button>

        <p className="px-3 pt-2 text-[11px] text-muted-foreground">
          {peers === 0 ? "Nobody else is here yet" : `${peers} peer${peers === 1 ? "" : "s"} connected`}
        </p>
      </div>
    </aside>
  );
}
