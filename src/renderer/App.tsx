import { useState } from "react";
import type { BootStatus, IdentityInfo } from "@/core/bridge";
import type { EventBody, EventKind } from "@/core/types";
import { LeftRail } from "./components/LeftRail";
import { RightRail } from "./components/RightRail";
import { Toast } from "./components/Toast";
import { NetworkPage } from "./pages/Network";
import { ProfilePage } from "./pages/Profile";
import { RiverPage } from "./pages/River";
import { useNode } from "./useNode";
import { useToast } from "./useToast";

export type View =
  | { name: "river" }
  | { name: "network" }
  | { name: "profile"; pubkey: string };

export default function App() {
  const [includeSilt, setIncludeSilt] = useState(false);
  const [view, setView] = useState<View>({ name: "river" });
  const { snapshot, identity, error, boot, refresh, publish } = useNode(includeSilt);
  const { message, notify } = useToast();

  const sealed = async (kind: EventKind, body: EventBody) => {
    const event = await publish(kind, body);
    notify(`Sealed · event ${event.seq} in your chain`);
    return event;
  };

  const openIdentity = identity as IdentityInfo | null;

  if (!snapshot || !openIdentity) {
    return <Boot error={error} boot={boot} />;
  }

  return (
    <>
      <div className="shell">
        <LeftRail
          snapshot={snapshot}
          identity={openIdentity}
          view={view}
          onNavigate={setView}
          publish={sealed}
          notify={notify}
        />

        <main className="feed-col">
          <div className="current" />

          {error && (
            <div
              style={{
                margin: "14px 0 0",
                fontSize: 12,
                color: "var(--danger)",
                display: "flex",
                gap: 10,
                alignItems: "center",
              }}
            >
              <span>{error}</span>
              <button className="btn btn-ghost" onClick={() => void refresh()}>
                retry
              </button>
            </div>
          )}

          {view.name === "river" && (
            <RiverPage
              snapshot={snapshot}
              me={openIdentity.publicKey}
              includeSilt={includeSilt}
              onToggleSilt={() => setIncludeSilt((value) => !value)}
              publish={sealed}
              notify={notify}
              onOpenProfile={(pubkey) => setView({ name: "profile", pubkey })}
              onOpenNetwork={() => setView({ name: "network" })}
            />
          )}

          {view.name === "network" && (
            <NetworkPage
              snapshot={snapshot}
              identity={openIdentity}
              notify={notify}
              onOpenProfile={(pubkey) => setView({ name: "profile", pubkey })}
            />
          )}

          {view.name === "profile" && (
            <ProfilePage
              pubkey={view.pubkey}
              snapshot={snapshot}
              me={openIdentity.publicKey}
              publish={sealed}
              notify={notify}
              onBack={() => setView({ name: "river" })}
              onOpenProfile={(pubkey) => setView({ name: "profile", pubkey })}
            />
          )}
        </main>

        <RightRail snapshot={snapshot} onNavigate={setView} publish={sealed} notify={notify} />
      </div>

      <Toast message={message} />
    </>
  );
}

function Boot({ error, boot }: { error: string | null; boot: BootStatus | null }) {
  const [resetting, setResetting] = useState(false);

  return (
    <div
      style={{
        height: "100vh",
        display: "grid",
        placeItems: "center",
        padding: 24,
      }}
    >
      <div style={{ textAlign: "center", maxWidth: 420 }}>
        <div className="wordmark" style={{ fontSize: 30 }}>
          River<em>.</em>
        </div>
        <p className="meta" style={{ marginTop: 12, lineHeight: 1.7 }}>
          {error ?? "starting your node, opening the ledger…"}
        </p>

        {boot?.identityLocked ? (
          <>
            <button
              className="btn btn-primary"
              style={{ marginTop: 18 }}
              disabled={resetting}
              onClick={() => {
                setResetting(true);
                void window.river.resetIdentity();
              }}
            >
              {resetting ? "restarting…" : "start a new identity"}
            </button>
            <p className="meta" style={{ marginTop: 14, fontSize: 11, lineHeight: 1.6 }}>
              The unreadable key file is renamed, not deleted. Anything it signed stays in the
              ledger and on the network — but this machine can no longer write as it.
            </p>
          </>
        ) : (
          <div
            className="skeleton"
            style={{ height: 2, marginTop: 22, width: 220, marginInline: "auto" }}
          />
        )}
      </div>
    </div>
  );
}
