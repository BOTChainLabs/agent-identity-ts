/**
 * Example: register (or read) an Agent identity on Bohr testnet (968).
 *
 * Env:
 *   RPC_URL                 optional RPC override
 *   PRIVATE_KEY             hex key (optional 0x) — enables Register
 *   AGENT_URI               optional initial tokenURI
 *   AGENT_IDENTITY_AGENT_ID decimal agentId — read-only ownerOf/tokenURI path
 */
import 'dotenv/config';

import { createWalletClient, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { createClient } from '../src/index.js';

async function main() {
  const rpcURL = process.env.RPC_URL;
  const client = await createClient(968, rpcURL ? { rpcUrl: rpcURL } : {});

  const cfg = client.chain();
  console.log(
    `chain_id=${cfg.chainId} name=${cfg.name} registry=${cfg.identityRegistryAddress} rpc=${cfg.rpcUrl}`,
  );

  const version = await client.getVersion();
  console.log(`getVersion=${version}`);

  const rawKey = process.env.PRIVATE_KEY?.trim();
  if (rawKey) {
    await register(client, rawKey);
    return;
  }

  const rawID = process.env.AGENT_IDENTITY_AGENT_ID;
  if (!rawID) {
    console.log('set PRIVATE_KEY to register, or AGENT_IDENTITY_AGENT_ID to read');
    return;
  }

  const agentId = BigInt(rawID);
  const owner = await client.ownerOf(agentId);
  const uri = await client.tokenURI(agentId);
  const ref = client.ref(agentId);
  console.log(`ref=(${ref.chainId}, ${ref.registryAddress}, ${ref.agentId})`);
  console.log(`ownerOf=${owner}`);
  console.log(`tokenURI=${uri}`);
}

async function register(
  client: Awaited<ReturnType<typeof createClient>>,
  rawKey: string,
) {
  const key = (rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`) as Hex;
  const account = privateKeyToAccount(key);
  const wallet = createWalletClient({
    account,
    chain: client.viemChain(),
    transport: http(process.env.RPC_URL ?? client.chain().rpcUrl),
  });

  console.log(`signer=${account.address}`);

  const params = { agentURI: process.env.AGENT_URI ?? '' };
  const gas = await client.estimateRegisterGas(account.address, params);
  console.log(`estimate_gas=${gas}`);

  const result = await client.register(wallet, params);
  console.log(`tx=${result.txHash}`);
  console.log(
    `ref=(${result.ref.chainId}, ${result.ref.registryAddress}, ${result.ref.agentId})`,
  );

  const owner = await client.ownerOf(result.ref.agentId);
  console.log(`ownerOf=${owner}`);
  if (owner.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error(`owner mismatch: chain=${owner} signer=${account.address}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
