import {
  type Address,
  type Chain,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
  createPublicClient,
  defineChain,
  http,
} from 'viem';

import {
  type ChainConfig,
  type SupportedChainId,
  byChainId,
  isSupportedChainId,
} from './chains.js';
import { UnsupportedChainError } from './errors.js';
import * as read from './read.js';
import * as registerMod from './register.js';
import type { ClientContext } from './tx.js';
import * as tx from './tx.js';
import type {
  IdentityRef,
  RegisterParams,
  RegisterResult,
  SetMetadataParams,
  SetMetadataResult,
  UpdateURIParams,
  UpdateURIResult,
} from './types.js';
import * as updateMod from './update.js';

export type CreateClientOptions = {
  /** Override the chain preset RPC endpoint. */
  rpcUrl?: string;
  /** Inject an already-built PublicClient (skips dialing). Must match chainId. */
  publicClient?: PublicClient;
};

function toViemChain(cfg: ChainConfig): Chain {
  return defineChain({
    id: cfg.chainId,
    name: cfg.name,
    nativeCurrency: { name: 'BOT', symbol: 'BOT', decimals: 18 },
    rpcUrls: {
      default: { http: [cfg.rpcUrl] },
    },
    blockExplorers: {
      default: { name: `${cfg.name} Explorer`, url: cfg.explorerUrl },
    },
  });
}

/**
 * Builds a client for a supported chain preset (677 or 968).
 * By default dials the preset RPC URL; use `rpcUrl` or `publicClient` to
 * customize. The RPC endpoint's eth_chainId must match `chainId`.
 */
export async function createClient(
  chainId: number,
  options: CreateClientOptions = {},
): Promise<IdentityClient> {
  if (!isSupportedChainId(chainId)) {
    throw new UnsupportedChainError(chainId);
  }

  let cfg: ChainConfig;
  try {
    cfg = byChainId(chainId);
  } catch {
    throw new UnsupportedChainError(chainId);
  }

  const rpcUrl = options.rpcUrl ?? cfg.rpcUrl;
  const viemChain = toViemChain({ ...cfg, rpcUrl });

  const publicClient =
    options.publicClient ??
    createPublicClient({
      chain: viemChain,
      transport: http(rpcUrl),
    });

  const got = await publicClient.getChainId();
  if (got !== chainId) {
    throw new Error(
      `agent-identity: RPC chain_id ${got} does not match requested ${chainId}`,
    );
  }

  return new IdentityClient(cfg, publicClient, viemChain);
}

/** Direct SDK surface for BOT Chain IdentityRegistry. */
export class IdentityClient {
  readonly #chain: ChainConfig;
  readonly #publicClient: PublicClient;
  readonly #viemChain: Chain;
  readonly #ctx: ClientContext;

  constructor(
    chain: ChainConfig,
    publicClient: PublicClient,
    viemChain: Chain,
  ) {
    this.#chain = chain;
    this.#publicClient = publicClient;
    this.#viemChain = viemChain;
    this.#ctx = {
      chain,
      viemChain,
      publicClient,
      registryAddress: chain.identityRegistryAddress,
    };
  }

  /** Active chain preset. */
  chain(): ChainConfig {
    return this.#chain;
  }

  /** IdentityRegistry proxy address. */
  registryAddress(): `0x${string}` {
    return this.#chain.identityRegistryAddress;
  }

  /** Underlying Viem PublicClient. */
  publicClient(): PublicClient {
    return this.#publicClient;
  }

  /** Viem chain definition matching the preset (useful when building WalletClient). */
  viemChain(): Chain {
    return this.#viemChain;
  }

  /** Assembles the on-chain identity locator. Does not call RPC. */
  ref(agentId: bigint): IdentityRef {
    return read.ref(this.#ctx, agentId);
  }

  ownerOf(agentId: bigint): Promise<Address> {
    return read.ownerOf(this.#ctx, agentId);
  }

  tokenURI(agentId: bigint): Promise<string> {
    return read.tokenURI(this.#ctx, agentId);
  }

  getVersion(): Promise<string> {
    return read.getVersion(this.#ctx);
  }

  getIdentity(agentId: bigint): Promise<IdentityRef> {
    return read.getIdentity(this.#ctx, agentId);
  }

  getMetadata(agentId: bigint, key: string): Promise<`0x${string}`> {
    return read.getMetadata(this.#ctx, agentId, key);
  }

  estimateRegisterGas(from: Address, params: RegisterParams = {}): Promise<bigint> {
    return registerMod.estimateRegisterGas(this.#ctx, from, params);
  }

  /**
   * Submits register(...), waits for the receipt, and parses agentId from Registered.
   * On wait / parse failure after broadcast, throws TxError with `txHash` set —
   * call `waitMined` / `parseRegisteredReceipt` before retrying register.
   */
  register(wallet: WalletClient, params: RegisterParams = {}): Promise<RegisterResult> {
    return registerMod.register(this.#ctx, wallet, params);
  }

  parseRegisteredReceipt(receipt: TransactionReceipt): IdentityRef {
    return registerMod.parseRegisteredReceipt(this.#ctx, receipt);
  }

  estimateUpdateURIGas(from: Address, params: UpdateURIParams): Promise<bigint> {
    return updateMod.estimateUpdateURIGas(this.#ctx, from, params);
  }

  updateURI(wallet: WalletClient, params: UpdateURIParams): Promise<UpdateURIResult> {
    return updateMod.updateURI(this.#ctx, wallet, params);
  }

  estimateSetMetadataGas(from: Address, params: SetMetadataParams): Promise<bigint> {
    return updateMod.estimateSetMetadataGas(this.#ctx, from, params);
  }

  setMetadata(wallet: WalletClient, params: SetMetadataParams): Promise<SetMetadataResult> {
    return updateMod.setMetadata(this.#ctx, wallet, params);
  }

  waitMined(txHash: `0x${string}`): Promise<TransactionReceipt> {
    return tx.waitMined(this.#ctx, txHash);
  }
}

export type { SupportedChainId };
