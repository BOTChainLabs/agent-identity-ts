import type { Address } from 'viem';

import { identityRegistryAbi } from './abi/IdentityRegistry.js';
import type { ClientContext } from './tx.js';
import type { IdentityRef } from './types.js';

export function ref(ctx: ClientContext, agentId: bigint): IdentityRef {
  return {
    chainId: ctx.chain.chainId,
    registryAddress: ctx.chain.identityRegistryAddress,
    agentId,
  };
}

export async function ownerOf(ctx: ClientContext, agentId: bigint): Promise<Address> {
  try {
    return (await ctx.publicClient.readContract({
      address: ctx.registryAddress,
      abi: identityRegistryAbi,
      functionName: 'ownerOf',
      args: [agentId],
    })) as Address;
  } catch (err) {
    throw new Error(
      `agent-identity: ownerOf(${agentId}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function tokenURI(ctx: ClientContext, agentId: bigint): Promise<string> {
  try {
    return (await ctx.publicClient.readContract({
      address: ctx.registryAddress,
      abi: identityRegistryAbi,
      functionName: 'tokenURI',
      args: [agentId],
    })) as string;
  } catch (err) {
    throw new Error(
      `agent-identity: tokenURI(${agentId}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function getVersion(ctx: ClientContext): Promise<string> {
  try {
    return (await ctx.publicClient.readContract({
      address: ctx.registryAddress,
      abi: identityRegistryAbi,
      functionName: 'getVersion',
    })) as string;
  } catch (err) {
    throw new Error(
      `agent-identity: getVersion: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function getIdentity(ctx: ClientContext, agentId: bigint): Promise<IdentityRef> {
  await ownerOf(ctx, agentId);
  return ref(ctx, agentId);
}

export async function getMetadata(
  ctx: ClientContext,
  agentId: bigint,
  key: string,
): Promise<`0x${string}`> {
  try {
    return (await ctx.publicClient.readContract({
      address: ctx.registryAddress,
      abi: identityRegistryAbi,
      functionName: 'getMetadata',
      args: [agentId, key],
    })) as `0x${string}`;
  } catch (err) {
    throw new Error(
      `agent-identity: getMetadata(${agentId}, ${JSON.stringify(key)}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
