import {
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
  TransactionNotFoundError,
  decodeErrorResult,
  toHex,
} from 'viem';

import { identityRegistryAbi } from './abi/IdentityRegistry.js';
import type { ChainConfig } from './chains.js';
import { TxError, wrapTx } from './errors.js';
import type { TxParams } from './types.js';

export const DEFAULT_GAS_BUFFER_BPS = 12_000;

export type ClientContext = {
  chain: ChainConfig;
  viemChain: Chain;
  publicClient: PublicClient;
  registryAddress: Address;
};

export type MinedTx = {
  receipt: TransactionReceipt;
  /** Hash that actually landed (differs from the submitted hash when repriced). */
  txHash: `0x${string}`;
};

export type ReplacementInfo = {
  reason: 'cancelled' | 'replaced' | 'repriced';
  transactionHash: `0x${string}`;
};

export function applyGasBuffer(gas: bigint, bps?: number): bigint {
  const buffer = bps && bps > 0 ? BigInt(bps) : BigInt(DEFAULT_GAS_BUFFER_BPS);
  return (gas * buffer + 9999n) / 10000n;
}

export function requireAccount(wallet: WalletClient): Address {
  const account = wallet.account;
  if (!account) {
    throw new TxError({
      kind: 'rpc',
      op: 'wallet',
      message: 'WalletClient has no account; pass account when creating the wallet',
    });
  }
  return typeof account === 'string' ? account : account.address;
}

/**
 * Ensures the wallet is on the SDK target chain before broadcast.
 * Checks WalletClient.chain when set, then eth_chainId from the wallet transport.
 */
export async function assertWalletChain(
  wallet: WalletClient,
  ctx: ClientContext,
): Promise<void> {
  const want = ctx.chain.chainId;
  if (wallet.chain != null && wallet.chain.id !== want) {
    throw new TxError({
      kind: 'rpc',
      op: 'chain check',
      message: `WalletClient.chain.id ${wallet.chain.id} does not match SDK chain ${want}`,
    });
  }
  let got: number;
  try {
    got = await wallet.getChainId();
  } catch (err) {
    throw wrapTx('chain check', err);
  }
  if (got !== want) {
    throw new TxError({
      kind: 'rpc',
      op: 'chain check',
      message: `wallet eth_chainId ${got} does not match SDK chain ${want}`,
    });
  }
}

export function toHexBytes(value: `0x${string}` | Uint8Array): Hex {
  if (typeof value === 'string') {
    return value;
  }
  return toHex(value);
}

export async function estimateContractGas(
  ctx: ClientContext,
  from: Address,
  data: Hex,
  bufferBps?: number,
): Promise<bigint> {
  try {
    const gas = await ctx.publicClient.estimateGas({
      account: from,
      to: ctx.registryAddress,
      data,
    });
    return applyGasBuffer(gas, bufferBps);
  } catch (err) {
    throw wrapTx('estimate gas', err);
  }
}

export async function resolveGasLimit(
  ctx: ClientContext,
  from: Address,
  params: TxParams,
  encode: () => Hex,
): Promise<bigint | undefined> {
  if (params.gasLimit !== undefined && params.gasLimit > 0n) {
    return params.gasLimit;
  }
  return estimateContractGas(ctx, from, encode(), params.gasBufferBps);
}

/**
 * Reject cancel / different-call replacements. Repriced (same call, higher fee)
 * is allowed — callers must use the mined hash from the returned receipt.
 */
export function assertAcceptableReplacement(
  op: string,
  submittedHash: `0x${string}`,
  replacement: ReplacementInfo | undefined,
): void {
  if (!replacement || replacement.reason === 'repriced') {
    return;
  }
  if (replacement.reason === 'cancelled') {
    throw new TxError({
      kind: 'rejected',
      op,
      message: `transaction cancelled by replacement (submitted ${submittedHash}, replacement ${replacement.transactionHash})`,
      txHash: submittedHash,
    });
  }
  throw new TxError({
    kind: 'rpc',
    op,
    message: `transaction replaced with a different call (submitted ${submittedHash}, replacement ${replacement.transactionHash})`,
    txHash: submittedHash,
  });
}

export type ReplacementHint = {
  from: Address;
  input: Hex;
  to: Address;
  /** Required for reliable replacement detection when the original hash is dropped. */
  nonce: number;
  value?: bigint;
};

export async function waitSuccess(
  ctx: ClientContext,
  submittedHash: `0x${string}`,
  op: string,
  hint?: ReplacementHint,
): Promise<MinedTx> {
  let replacement: ReplacementInfo | undefined;

  const waitParams: Parameters<PublicClient['waitForTransactionReceipt']>[0] = {
    hash: submittedHash,
    onReplaced: (r) => {
      replacement = {
        reason: r.reason,
        transactionHash: r.transaction.hash,
      };
    },
  };

  if (hint) {
    // Pass sender+nonce so Viem can find a same-nonce replacement even when the
    // original hash has already been dropped by the RPC (getTransaction fails).
    // Without these fields, Viem skips the replacement scan and the wait may
    // only surface as a timeout after the replacement has already mined.
    waitParams.replacement = {
      from: hint.from,
      nonce: hint.nonce,
      input: hint.input,
      to: hint.to,
      value: hint.value ?? 0n,
    };
  }

  let receipt: TransactionReceipt;
  try {
    receipt = await ctx.publicClient.waitForTransactionReceipt(waitParams);
  } catch (err) {
    throw wrapTx('wait receipt', err, submittedHash);
  }

  assertAcceptableReplacement(op, submittedHash, replacement);

  const minedHash = receipt.transactionHash;
  if (receipt.status !== 'success') {
    throw new TxError({
      kind: 'revert',
      op,
      message: `transaction reverted: ${minedHash}`,
      txHash: minedHash,
    });
  }
  return { receipt, txHash: minedHash };
}

type InFlightTx = {
  hash: `0x${string}`;
  /**
   * Drop checks stay off until a wait has timed out / failed without a receipt.
   * A bare timeout is not proof the tx was dropped — reconcile still requires
   * pending nonce + getTransaction lookup.
   */
  dropChecksEnabled: boolean;
};

/**
 * Coordinates nonce assignment + broadcast for one (chainId, address) in-process.
 * Concurrent SDK writes on the same account must not both read the same pending
 * nonce and pass it explicitly to the wallet. Waiting for receipts happens
 * outside the lock so replacements can still be tracked in parallel.
 *
 * Local next-nonce is reconciled against RPC pending + tx lookup when a
 * broadcast later disappears from the mempool, so gaps do not permanently
 * stall the account. Wait timeout alone never frees a nonce.
 */
export type AccountNonceState = {
  /** Next nonce including mempool txs (`pending` block tag). */
  pending: number;
  /** Next nonce from the latest confirmed block only. */
  latest: number;
};

/**
 * Result of probing a submitted hash after wait failure.
 * Only `not_found` frees an in-flight nonce; RPC/network errors are `unavailable`
 * and must keep the reservation.
 */
export type TxPresence = 'known' | 'not_found' | 'unavailable';

/** Maps getTransaction failures: only TransactionNotFoundError means dropped. */
export function txPresenceFromLookupError(err: unknown): TxPresence {
  if (err instanceof TransactionNotFoundError) {
    return 'not_found';
  }
  return 'unavailable';
}

export class AccountWriteCoordinator {
  #tail: Promise<void> = Promise.resolve();
  /** First reusable nonce after last reconcile (floor + in-flight holes). */
  #localNext: number | undefined;
  /** Last allocation floor = max(pending, latest). */
  #lastFloor = 0;
  #inFlight = new Map<number, InFlightTx>();

  /**
   * Runs `broadcast(nonce)` exclusively after reconciling with chain state.
   * `broadcast` must return the submitted tx hash so the nonce can be tracked.
   * Assigned nonce is the first value >= max(pending, latest) not held by local
   * in-flight txs (so a dropped lower nonce is filled before skipping ahead of a
   * still-queued higher one, and a lagging pending read cannot reuse a mined nonce).
   */
  async runBroadcast<T extends { txHash: `0x${string}` }>(
    readNonces: () => Promise<AccountNonceState>,
    lookupTx: (hash: `0x${string}`) => Promise<TxPresence>,
    broadcast: (nonce: number) => Promise<T>,
  ): Promise<T & { nonce: number }> {
    let release!: () => void;
    const prev = this.#tail;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      const { pending, latest } = await readNonces();
      const floor = Math.max(pending, latest);
      await this.#reconcileUnlocked(floor, latest, lookupTx);
      const nonce = this.#firstFreeNonce(floor);
      const result = await broadcast(nonce);
      this.#inFlight.set(nonce, { hash: result.txHash, dropChecksEnabled: false });
      this.#recomputeLocalNext(floor);
      return { ...result, nonce };
    } finally {
      release();
    }
  }

  /** Nonce was mined / reverted / replaced — release the reservation. */
  noteSettled(nonce: number): void {
    this.#inFlight.delete(nonce);
    if (this.#inFlight.size === 0) {
      this.#localNext = undefined;
      return;
    }
    this.#recomputeLocalNext(this.#lastFloor);
  }

  /**
   * After wait failure without a receipt: allow drop checks for this nonce, then
   * reconcile. Still requires pending/`latest` + getTransaction — timeout alone is not enough.
   * Lookup must return `not_found` to free; `unavailable` keeps the reservation.
   */
  async observeAfterWaitFailure(
    nonce: number,
    readNonces: () => Promise<AccountNonceState>,
    lookupTx: (hash: `0x${string}`) => Promise<TxPresence>,
  ): Promise<void> {
    let release!: () => void;
    const prev = this.#tail;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      const entry = this.#inFlight.get(nonce);
      if (entry) {
        entry.dropChecksEnabled = true;
      }
      const { pending, latest } = await readNonces();
      await this.#reconcileUnlocked(Math.max(pending, latest), latest, lookupTx);
    } finally {
      release();
    }
  }

  /** Test helper: last reserved next-nonce, if any. */
  peekLocalNext(): number | undefined {
    return this.#localNext;
  }

  /** Test helper: in-flight nonce keys. */
  peekInFlightNonces(): number[] {
    return [...this.#inFlight.keys()].sort((a, b) => a - b);
  }

  async #reconcileUnlocked(
    floor: number,
    latest: number,
    lookupTx: (hash: `0x${string}`) => Promise<TxPresence>,
  ): Promise<void> {
    for (const [nonce, entry] of [...this.#inFlight]) {
      if (nonce < latest) {
        // Confirmed on-chain past this nonce (mined or replaced in a block).
        // Do NOT use pending here: mempool txs also make pending > nonce.
        this.#inFlight.delete(nonce);
        continue;
      }
      if (!entry.dropChecksEnabled) {
        continue;
      }
      // Wait already failed without a receipt: probe the hash.
      // Only an explicit not-found frees the gap; RPC/network errors keep it.
      const presence = await lookupTx(entry.hash);
      if (presence === 'not_found') {
        this.#inFlight.delete(nonce);
      }
    }
    this.#recomputeLocalNext(floor);
  }

  /** Lowest nonce >= floor that is not reserved by a local in-flight broadcast. */
  #firstFreeNonce(floor: number): number {
    let nonce = floor;
    while (this.#inFlight.has(nonce)) {
      nonce += 1;
    }
    return nonce;
  }

  #recomputeLocalNext(floor: number): void {
    this.#lastFloor = floor;
    this.#localNext = this.#firstFreeNonce(floor);
  }
}

const writeCoordinators = new Map<string, AccountWriteCoordinator>();

export function accountWriteCoordinator(
  chainId: number,
  address: Address,
): AccountWriteCoordinator {
  const key = `${chainId}:${address.toLowerCase()}`;
  let gate = writeCoordinators.get(key);
  if (!gate) {
    gate = new AccountWriteCoordinator();
    writeCoordinators.set(key, gate);
  }
  return gate;
}

/** Clears in-process write gates (tests only). */
export function resetAccountWriteCoordinators(): void {
  writeCoordinators.clear();
}

/**
 * Broadcasts a contract write on the SDK target chain and waits for success.
 * Assigns nonce under a per-(chain, address) gate so concurrent SDK calls do
 * not collide, then passes that nonce to Viem replacement detection.
 */
export async function sendWriteTx(
  ctx: ClientContext,
  wallet: WalletClient,
  op: string,
  data: Hex,
  gas: bigint | undefined,
): Promise<MinedTx> {
  const account = requireAccount(wallet);
  await assertWalletChain(wallet, ctx);

  const gate = accountWriteCoordinator(ctx.chain.chainId, account);

  const readNonces = async (): Promise<AccountNonceState> => {
    try {
      const [pending, latest] = await Promise.all([
        ctx.publicClient.getTransactionCount({
          address: account,
          blockTag: 'pending',
        }),
        ctx.publicClient.getTransactionCount({
          address: account,
          blockTag: 'latest',
        }),
      ]);
      return { pending, latest };
    } catch (err) {
      throw wrapTx('account nonce', err);
    }
  };

  const lookupTx = async (hash: `0x${string}`): Promise<TxPresence> => {
    try {
      await ctx.publicClient.getTransaction({ hash });
      return 'known';
    } catch (err) {
      return txPresenceFromLookupError(err);
    }
  };

  const submitted = await gate.runBroadcast(readNonces, lookupTx, async (nonce) => {
    try {
      const txHash = await wallet.sendTransaction({
        to: ctx.registryAddress,
        data,
        account: wallet.account!,
        chain: ctx.viemChain,
        nonce,
        ...(gas !== undefined ? { gas } : {}),
      });
      return { txHash };
    } catch (err) {
      throw wrapTx(op, err);
    }
  });

  try {
    const mined = await waitSuccess(ctx, submitted.txHash, op, {
      from: account,
      nonce: submitted.nonce,
      input: data,
      to: ctx.registryAddress,
      value: 0n,
    });
    gate.noteSettled(submitted.nonce);
    return mined;
  } catch (err) {
    // Receipt-based failures consumed the nonce (revert / cancel / replace mined).
    // Timeouts and transport errors do not — reconcile only via pending + lookup.
    if (nonceConsumedAfterWait(err)) {
      gate.noteSettled(submitted.nonce);
    } else {
      try {
        await gate.observeAfterWaitFailure(submitted.nonce, readNonces, lookupTx);
      } catch {
        // Best-effort reconcile; still surface the original wait error.
      }
    }
    throw wrapTx(op, err, submitted.txHash);
  }
}

function nonceConsumedAfterWait(err: unknown): boolean {
  if (!(err instanceof TxError)) return false;
  if (err.kind === 'revert' || err.kind === 'rejected') return true;
  return err.message.includes('replaced with a different call');
}

/**
 * Waits until txHash is mined and returns the receipt (any status).
 * Use after a write method threw a TxError with txHash — do not blindly
 * retry register, which would mint another identity.
 *
 * Follows Viem replacement detection when the original tx is still queryable.
 * If the RPC has already dropped the hash and the caller does not pass
 * sender/nonce via a lower-level wait, a mined replacement may only appear as
 * a timeout — inspect the explorer / account nonce before retrying register.
 * Callers must still check receipt status and parse events.
 */
export async function waitMined(
  ctx: ClientContext,
  txHash: `0x${string}`,
): Promise<TransactionReceipt> {
  const hash = parseExactHash(txHash);
  try {
    return await ctx.publicClient.waitForTransactionReceipt({ hash });
  } catch (err) {
    throw wrapTx('wait receipt', err, hash);
  }
}

/** Requires a full 32-byte hash (with or without 0x). */
export function parseExactHash(txHash: string): `0x${string}` {
  const raw = txHash.trim().replace(/^0x/i, '');
  if (raw.length !== 64 || !/^[0-9a-fA-F]+$/.test(raw)) {
    throw new Error(
      `agent-identity: invalid tx hash ${JSON.stringify(txHash)}: want 32 bytes (64 hex chars)`,
    );
  }
  return `0x${raw.toLowerCase()}` as `0x${string}`;
}

export async function requireOwner(
  ctx: ClientContext,
  agentId: bigint,
  signer: Address,
): Promise<void> {
  let owner: Address;
  try {
    owner = (await ctx.publicClient.readContract({
      address: ctx.registryAddress,
      abi: identityRegistryAbi,
      functionName: 'ownerOf',
      args: [agentId],
    })) as Address;
  } catch (err) {
    throw new Error(`agent-identity: ownerOf(${agentId}): ${errorText(err)}`);
  }
  if (owner.toLowerCase() !== signer.toLowerCase()) {
    throw new TxError({
      kind: 'revert',
      op: 'owner check',
      message: `signer ${signer} is not NFT owner ${owner} for agentId ${agentId}`,
    });
  }
}

/** Best-effort decode of revert data for error messages. */
export function decodeRevert(data: Hex | undefined): string | undefined {
  if (!data) return undefined;
  try {
    const decoded = decodeErrorResult({ abi: identityRegistryAbi, data });
    return `${decoded.errorName}(${decoded.args?.map(String).join(', ') ?? ''})`;
  } catch {
    return undefined;
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
