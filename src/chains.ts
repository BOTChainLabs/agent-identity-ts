/** BOT Chain presets for the ERC-8004 IdentityRegistry. */

export const MAINNET_CHAIN_ID = 677 as const;
export const TESTNET_CHAIN_ID = 968 as const;

export type SupportedChainId = typeof MAINNET_CHAIN_ID | typeof TESTNET_CHAIN_ID;

export type ChainConfig = {
  chainId: SupportedChainId;
  name: string;
  rpcUrl: string;
  explorerUrl: string;
  identityRegistryAddress: `0x${string}`;
};

/** BOT Chain mainnet (677). */
export const mainnet: ChainConfig = {
  chainId: MAINNET_CHAIN_ID,
  name: 'BOT Chain',
  rpcUrl: 'https://rpc.botchain.ai',
  explorerUrl: 'https://scan.botchain.ai',
  identityRegistryAddress: '0xB43Edfb9C7609cF645e932B2fF20f26F0d4488dE',
};

/** Bohr testnet (968). */
export const testnet: ChainConfig = {
  chainId: TESTNET_CHAIN_ID,
  name: 'Bohr Testnet',
  rpcUrl: 'https://rpc.bohr.life',
  explorerUrl: 'https://scan.bohr.life',
  identityRegistryAddress: '0xec8fFbC3c9A34AdDCbB3A14F91db2bd26A8b99c0',
};

/** Returns a built-in preset or throws UnsupportedChainError. */
export function byChainId(chainId: number): ChainConfig {
  switch (chainId) {
    case MAINNET_CHAIN_ID:
      return mainnet;
    case TESTNET_CHAIN_ID:
      return testnet;
    default:
      // Lazy import avoided — caller wraps with UnsupportedChainError in createClient.
      throw new Error(
        `unsupported chain_id ${chainId}: only 677 and 968 are configured`,
      );
  }
}

export function isSupportedChainId(chainId: number): chainId is SupportedChainId {
  return chainId === MAINNET_CHAIN_ID || chainId === TESTNET_CHAIN_ID;
}
