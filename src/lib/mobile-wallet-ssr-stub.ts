// Server-only stand-in for @solana-mobile/wallet-adapter-mobile. The real package crashes the
// Worker at import time; mobile wallets can only connect in a browser, where the real one loads.
export const SolanaMobileWalletAdapterWalletName = "Mobile Wallet Adapter";
export class SolanaMobileWalletAdapter {
  name = SolanaMobileWalletAdapterWalletName;
  constructor() {
    throw new Error("Mobile wallet adapter is browser-only");
  }
}
export const createDefaultAddressSelector = () => ({ select: async (a: string[]) => a[0] });
export const createDefaultAuthorizationResultCache = () => ({
  clear: async () => {},
  get: async () => undefined,
  set: async () => {},
});
export const createDefaultWalletNotFoundHandler = () => async () => {};
