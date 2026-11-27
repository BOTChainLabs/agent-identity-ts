import type { SupportedChainId } from './chains.js';

/** Full on-chain identity locator. */
export type IdentityRef = {
  chainId: SupportedChainId;
  registryAddress: `0x${string}`;
  agentId: bigint;
};

/** Returned after a successful register + receipt parse. */
export type RegisterResult = {
  ref: IdentityRef;
  txHash: `0x${string}`;
};

/** On-chain metadata passed to register(uri, metadata). */
export type MetadataEntry = {
  key: string;
  value: `0x${string}` | Uint8Array;
};

/** Shared gas overrides for write methods. */
export type TxParams = {
  /** Explicit gas limit; when omitted the SDK estimates with a buffer. */
  gasLimit?: bigint;
  /**
   * Gas estimate buffer in basis points (default 12000 = 1.2×).
   * Example: 15000 → 1.5× estimated gas.
   */
  gasBufferBps?: number;
};

export type RegisterParams = TxParams & {
  /** Initial tokenURI. Empty / omitted uses register() with no URI. */
  agentURI?: string;
  /** When non-empty, uses register(uri, metadata). */
  metadata?: MetadataEntry[];
};

export type UpdateURIParams = TxParams & {
  agentId: bigint;
  newURI: string;
};

export type UpdateURIResult = {
  ref: IdentityRef;
  txHash: `0x${string}`;
  newURI: string;
};

export type SetMetadataParams = TxParams & {
  agentId: bigint;
  key: string;
  value: `0x${string}` | Uint8Array;
};

export type SetMetadataResult = {
  ref: IdentityRef;
  txHash: `0x${string}`;
  key: string;
};
