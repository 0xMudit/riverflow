import { useState } from "react";
import type { WalletInfo } from "@/core/bridge";
import { shortAddr } from "../format";
import { walletName, wallets, type Eip1193Provider } from "../wallet";

/**
 * The wallet panel.
 *
 * A wallet is a second way to be you: the key you already carry, in
 * MetaMask or a hardware box, signing the same events your local key signs.
 * It is optional — the local key in the keychain is the default — and it is
 * never required of anybody.
 */
export function WalletPanel({
  wallet,
  onConnect,
  onDisconnect,
  notify,
}: {
  wallet: WalletInfo | null;
  onConnect: (provider: Eip1193Provider) => void;
  onDisconnect: () => void;
  notify: (message: string) => void;
}) {
  const [picking, setPicking] = useState(false);
  const available = wallets();

  if (wallet) {
    return (
      <div style={{ marginTop: 12 }}>
        <div className="label" style={{ marginBottom: 6 }}>
          Wallet
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="mono" style={{ fontSize: 11 }}>
            {shortAddr(wallet.address)}
          </span>
          <span className="chip chip-water">{wallet.signedIn ? "signed in" : "not signed in"}</span>
        </div>
        <div style={{ display: "flex", gap: 4, marginTop: 8, flexWrap: "wrap" }}>
          <button
            className="btn btn-ghost"
            style={{ fontSize: 11 }}
            onClick={() => {
              onDisconnect();
              notify("Writing with the local key again");
            }}
          >
            use the local key
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 12 }}>
      <div className="label" style={{ marginBottom: 6 }}>
        Wallet
      </div>
      {!picking ? (
        <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => setPicking(true)}>
          connect a wallet
        </button>
      ) : available.length === 0 ? (
        <p className="meta" style={{ fontSize: 11, lineHeight: 1.6 }}>
          No wallet found in this window. Your local key works on its own — a wallet is only another
          way to hold it.
        </p>
      ) : (
        <div style={{ display: "grid", gap: 4 }}>
          {available.map((provider, index) => (
            <button
              key={index}
              className="btn btn-ghost"
              style={{ fontSize: 11, textAlign: "left" }}
              onClick={() => {
                setPicking(false);
                onConnect(provider);
              }}
            >
              {walletName(provider)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
