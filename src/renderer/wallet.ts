/**
 * Wallets in the window.
 *
 * Any EIP-1193 wallet will do — MetaMask, Rabby, Brave, anything that answers
 * `eth_requestAccounts`. River asks for nothing else, and the key never
 * leaves the wallet: the window only ever asks it to sign, and the node only
 * ever checks the signature.
 *
 * A wallet is optional. The local key in the operating system's keychain is
 * the default, and a person who has no wallet is not left out.
 */

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  isMetaMask?: boolean;
  providers?: Eip1193Provider[];
}

interface EthereumLike {
  providers?: Eip1193Provider[];
  isMetaMask?: boolean;
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
}

function root(): EthereumLike | undefined {
  return (window as unknown as { ethereum?: EthereumLike }).ethereum;
}

/** Every wallet that has injected itself into this page. */
export function wallets(): Eip1193Provider[] {
  const injected = root();
  if (!injected) return [];
  const list = injected.providers?.length ? injected.providers : [injected];
  return list.filter((provider) => typeof provider?.request === "function");
}

/** A name for the wallet, so the person knows which one they are talking to. */
export function walletName(provider: Eip1193Provider): string {
  if (provider.isMetaMask) return "MetaMask";
  const known = provider as unknown as { isRabby?: boolean; isBraveWallet?: boolean };
  if (known.isRabby) return "Rabby";
  if (known.isBraveWallet) return "Brave";
  return "wallet";
}

/** Ask the wallet for an account. The person has to say yes. */
export async function connect(provider: Eip1193Provider): Promise<string> {
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  const address = accounts?.[0];
  if (!address) throw new Error("the wallet gave no account");
  return address;
}

/** Sign 32 bytes. The bytes are what the person is signing; nothing else. */
export async function signBytes(
  provider: Eip1193Provider,
  address: string,
  hex: string,
): Promise<string> {
  const data = hex.startsWith("0x") ? hex : `0x${hex}`;
  try {
    return (await provider.request({ method: "personal_sign", params: [data, address] })) as string;
  } catch {
    // Some wallets take the address first.
    return (await provider.request({ method: "personal_sign", params: [address, data] })) as string;
  }
}

/** Sign a piece of text, the way a sign-in statement is signed. */
export async function signText(
  provider: Eip1193Provider,
  address: string,
  text: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return signBytes(provider, address, `0x${hex}`);
}
