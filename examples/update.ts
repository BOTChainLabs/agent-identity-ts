/**
 * Example: register, update URI, and set metadata on Bohr testnet (968).
 *
 * Env:
 *   PRIVATE_KEY     required (hex, optional 0x prefix)
 *   AGENT_URI       initial URI for register (optional)
 *   NEW_AGENT_URI   URI after update (required)
 *   METADATA_KEY    optional (default "sdk.smoke")
 *   METADATA_VALUE  optional (default "ok")
 *   RPC_URL         optional
 */
import 'dotenv/config';

import { createWalletClient, http, stringToHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { createClient, TxError } from '../src/index.js';

async function main() {
  const rawKey = process.env.PRIVATE_KEY?.trim();
  if (!rawKey) {
    throw new Error('PRIVATE_KEY is required');
  }
  const newURI = process.env.NEW_AGENT_URI;
  if (!newURI) {
    throw new Error('NEW_AGENT_URI is required');
  }
  const metaKey = process.env.METADATA_KEY || 'sdk.smoke';
  const metaValue = stringToHex(process.env.METADATA_VALUE || 'ok');

  const client = await createClient(968, {
    ...(process.env.RPC_URL ? { rpcUrl: process.env.RPC_URL } : {}),
  });

  const key = (rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`) as Hex;
  const account = privateKeyToAccount(key);
  const wallet = createWalletClient({
    account,
    chain: client.viemChain(),
    transport: http(process.env.RPC_URL ?? client.chain().rpcUrl),
  });

  let reg;
  try {
    reg = await client.register(wallet, { agentURI: process.env.AGENT_URI ?? '' });
  } catch (err) {
    if (err instanceof TxError && err.txHash) {
      console.error(`register pending tx=${err.txHash}: ${err.message}`);
    }
    throw err;
  }
  console.log(`registered agent_id=${reg.ref.agentId} tx=${reg.txHash}`);

  let upd;
  try {
    upd = await client.updateURI(wallet, {
      agentId: reg.ref.agentId,
      newURI,
    });
  } catch (err) {
    if (err instanceof TxError && err.txHash) {
      console.error(`updateURI pending tx=${err.txHash}: ${err.message}`);
    }
    throw err;
  }
  console.log(`updated uri=${upd.newURI} tx=${upd.txHash}`);

  const got = await client.tokenURI(reg.ref.agentId);
  console.log(`tokenURI=${got}`);
  if (got !== newURI) {
    throw new Error(`tokenURI mismatch: got ${JSON.stringify(got)} want ${JSON.stringify(newURI)}`);
  }

  let meta;
  try {
    meta = await client.setMetadata(wallet, {
      agentId: reg.ref.agentId,
      key: metaKey,
      value: metaValue,
    });
  } catch (err) {
    if (err instanceof TxError && err.txHash) {
      console.error(`setMetadata pending tx=${err.txHash}: ${err.message}`);
    }
    throw err;
  }
  console.log(`setMetadata key=${meta.key} tx=${meta.txHash}`);

  const value = await client.getMetadata(reg.ref.agentId, metaKey);
  console.log(`getMetadata=${value}`);
  if (value.toLowerCase() !== metaValue.toLowerCase()) {
    throw new Error(
      `getMetadata mismatch: got ${JSON.stringify(value)} want ${JSON.stringify(metaValue)}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
