import {
  type Address,
  type Hex,
  type WalletClient,
  encodeFunctionData,
} from 'viem';

import { identityRegistryAbi } from './abi/IdentityRegistry.js';
import * as read from './read.js';
import {
  type ClientContext,
  requireAccount,
  requireOwner,
  resolveGasLimit,
  sendWriteTx,
  toHexBytes,
} from './tx.js';
import type {
  SetMetadataParams,
  SetMetadataResult,
  UpdateURIParams,
  UpdateURIResult,
} from './types.js';

function encodeSetAgentURI(agentId: bigint, newURI: string): Hex {
  return encodeFunctionData({
    abi: identityRegistryAbi,
    functionName: 'setAgentURI',
    args: [agentId, newURI],
  });
}

function encodeSetMetadata(agentId: bigint, key: string, value: Hex): Hex {
  return encodeFunctionData({
    abi: identityRegistryAbi,
    functionName: 'setMetadata',
    args: [agentId, key, value],
  });
}

export async function estimateUpdateURIGas(
  ctx: ClientContext,
  from: Address,
  params: UpdateURIParams,
): Promise<bigint> {
  const gas = await resolveGasLimit(ctx, from, params, () =>
    encodeSetAgentURI(params.agentId, params.newURI),
  );
  return gas ?? 0n;
}

export async function updateURI(
  ctx: ClientContext,
  wallet: WalletClient,
  params: UpdateURIParams,
): Promise<UpdateURIResult> {
  const account = requireAccount(wallet);
  await requireOwner(ctx, params.agentId, account);

  const data = encodeSetAgentURI(params.agentId, params.newURI);
  const gas = await resolveGasLimit(ctx, account, params, () => data);
  const mined = await sendWriteTx(ctx, wallet, 'setAgentURI', data, gas);

  return {
    ref: read.ref(ctx, params.agentId),
    txHash: mined.txHash,
    newURI: params.newURI,
  };
}

export async function estimateSetMetadataGas(
  ctx: ClientContext,
  from: Address,
  params: SetMetadataParams,
): Promise<bigint> {
  const value = toHexBytes(params.value);
  const gas = await resolveGasLimit(ctx, from, params, () =>
    encodeSetMetadata(params.agentId, params.key, value),
  );
  return gas ?? 0n;
}

export async function setMetadata(
  ctx: ClientContext,
  wallet: WalletClient,
  params: SetMetadataParams,
): Promise<SetMetadataResult> {
  const account = requireAccount(wallet);
  await requireOwner(ctx, params.agentId, account);

  const value = toHexBytes(params.value);
  const data = encodeSetMetadata(params.agentId, params.key, value);
  const gas = await resolveGasLimit(ctx, account, params, () => data);
  const mined = await sendWriteTx(ctx, wallet, 'setMetadata', data, gas);

  return {
    ref: read.ref(ctx, params.agentId),
    txHash: mined.txHash,
    key: params.key,
  };
}
