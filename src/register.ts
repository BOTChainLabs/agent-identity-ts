import {
  type Address,
  type Hex,
  type TransactionReceipt,
  type WalletClient,
  decodeEventLog,
  encodeFunctionData,
} from 'viem';

import { identityRegistryAbi } from './abi/IdentityRegistry.js';
import { wrapTx } from './errors.js';
import * as read from './read.js';
import {
  type ClientContext,
  requireAccount,
  resolveGasLimit,
  sendWriteTx,
  toHexBytes,
} from './tx.js';
import type { IdentityRef, RegisterParams, RegisterResult } from './types.js';

type MetadataTuple = {
  metadataKey: string;
  metadataValue: Hex;
};

function normalizeMetadata(
  entries: RegisterParams['metadata'],
): MetadataTuple[] | undefined {
  if (!entries || entries.length === 0) return undefined;
  return entries.map((m) => ({
    metadataKey: m.key,
    metadataValue: toHexBytes(m.value),
  }));
}

export function encodeRegister(params: RegisterParams): Hex {
  const metadata = normalizeMetadata(params.metadata);
  const uri = params.agentURI ?? '';
  if (metadata) {
    return encodeFunctionData({
      abi: identityRegistryAbi,
      functionName: 'register',
      args: [uri, metadata],
      // Overloaded register — force selection by args shape.
    } as never);
  }
  if (uri !== '') {
    return encodeFunctionData({
      abi: identityRegistryAbi,
      functionName: 'register',
      args: [uri],
    } as never);
  }
  return encodeFunctionData({
    abi: identityRegistryAbi,
    functionName: 'register',
    args: [],
  } as never);
}

export async function estimateRegisterGas(
  ctx: ClientContext,
  from: Address,
  params: RegisterParams = {},
): Promise<bigint> {
  const gas = await resolveGasLimit(ctx, from, params, () => encodeRegister(params));
  return gas ?? 0n;
}

export async function register(
  ctx: ClientContext,
  wallet: WalletClient,
  params: RegisterParams = {},
): Promise<RegisterResult> {
  const account = requireAccount(wallet);
  const data = encodeRegister(params);
  const gas = await resolveGasLimit(ctx, account, params, () => data);

  const mined = await sendWriteTx(ctx, wallet, 'register', data, gas);

  try {
    const identity = parseRegisteredReceipt(ctx, mined.receipt);
    return { ref: identity, txHash: mined.txHash };
  } catch (err) {
    throw wrapTx('parse Registered', err, mined.txHash);
  }
}

/** Extracts IdentityRef from a mined register receipt. */
export function parseRegisteredReceipt(
  ctx: ClientContext,
  receipt: TransactionReceipt,
): IdentityRef {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== ctx.registryAddress.toLowerCase()) {
      continue;
    }
    try {
      const decoded = decodeEventLog({
        abi: identityRegistryAbi,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName !== 'Registered') {
        continue;
      }
      const args = decoded.args as { agentId?: bigint };
      if (args.agentId === undefined) {
        throw new Error('agent-identity: Registered event missing agentId');
      }
      return read.ref(ctx, args.agentId);
    } catch (err) {
      if (err instanceof Error && err.message.includes('Registered event missing')) {
        throw err;
      }
      // Not a Registered log — keep scanning.
    }
  }

  throw new Error(
    `agent-identity: Registered event missing from receipt ${receipt.transactionHash} for registry ${ctx.registryAddress}`,
  );
}
