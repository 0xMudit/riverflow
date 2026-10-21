import { useState } from "react";
import { Wallet } from "lucide-react";
import type { WalletInfo } from "@/core/bridge";
import { shortAddr } from "../format";
import { walletName, wallets, type Eip1193Provider } from "../wallet";
import { Button } from "@/ui/button";
import { Badge } from "@/ui/badge";
import { cn } from "@/lib/utils";

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
      <div>
        <div className="flex items-center gap-2">
          <Wallet className="size-4 text-muted-foreground" />
          <span className="mono text-sm">{shortAddr(wallet.address)}</span>
          {wallet.signedIn ? (
            <Badge className="h-5 border-primary/40 bg-primary/10 px-1.5 text-[10px] text-primary">
              signed in
            </Badge>
          ) : (
            <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
              not signed in
            </Badge>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="mt-2 h-8 px-2 text-xs text-muted-foreground"
          onClick={() => {
            onDisconnect();
            notify("Writing with the local key again");
          }}
        >
          Use the local key instead
        </Button>
      </div>
    );
  }

  return (
    <div>
      {!picking ? (
        <Button variant="outline" size="sm" onClick={() => setPicking(true)}>
          <Wallet className="size-4" />
          Connect a wallet
        </Button>
      ) : available.length === 0 ? (
        <p className="text-sm leading-relaxed text-muted-foreground">
          No wallet found in this window. Your local key works on its own — a wallet is only another
          way to hold it.
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {available.map((provider, index) => (
            <Button
              key={index}
              variant="outline"
              size="sm"
              className={cn("rounded-full")}
              onClick={() => {
                setPicking(false);
                onConnect(provider);
              }}
            >
              {walletName(provider)}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
