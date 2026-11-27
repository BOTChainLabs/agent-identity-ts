import { describe, expect, it } from 'vitest';

import {
  MAINNET_CHAIN_ID,
  TESTNET_CHAIN_ID,
  byChainId,
  isSupportedChainId,
  mainnet,
  testnet,
} from '../src/chains.js';
import { UnsupportedChainError } from '../src/errors.js';
import { createClient } from '../src/client.js';
import { identityRegistryAbi } from '../src/abi/IdentityRegistry.js';
import {
  AccountWriteCoordinator,
  applyGasBuffer,
  assertAcceptableReplacement,
  parseExactHash,
  resetAccountWriteCoordinators,
  txPresenceFromLookupError,
  type TxPresence,
} from '../src/tx.js';
import { classifyTxErr, TxError } from '../src/errors.js';
import { defineChain, TransactionNotFoundError } from 'viem';

function presenceFromMempool(
  mempool: Map<`0x${string}`, number> | Set<`0x${string}`>,
): (hash: `0x${string}`) => Promise<TxPresence> {
  return async (hash) => (mempool.has(hash) ? 'known' : 'not_found');
}

describe('chains', () => {
  it('exposes preset registry addresses', () => {
    expect(testnet.chainId).toBe(TESTNET_CHAIN_ID);
    expect(testnet.identityRegistryAddress).toBe(
      '0xec8fFbC3c9A34AdDCbB3A14F91db2bd26A8b99c0',
    );
    expect(mainnet.chainId).toBe(MAINNET_CHAIN_ID);
    expect(mainnet.identityRegistryAddress).toBe(
      '0xB43Edfb9C7609cF645e932B2fF20f26F0d4488dE',
    );
  });

  it('byChainId rejects unsupported ids', () => {
    expect(() => byChainId(1)).toThrow(/unsupported chain_id/);
    expect(isSupportedChainId(968)).toBe(true);
    expect(isSupportedChainId(1)).toBe(false);
  });
});

describe('createClient', () => {
  it('rejects unsupported chain before dialing', async () => {
    await expect(createClient(1)).rejects.toBeInstanceOf(UnsupportedChainError);
  });
});

describe('ABI', () => {
  it('includes required methods and Registered event', () => {
    const names = new Set(
      (identityRegistryAbi as Array<{ type?: string; name?: string }>)
        .filter((x) => x.type === 'function' || x.type === 'event')
        .map((x) => x.name),
    );
    for (const name of [
      'ownerOf',
      'tokenURI',
      'getVersion',
      'getMetadata',
      'register',
      'setAgentURI',
      'setMetadata',
      'Registered',
    ]) {
      expect(names.has(name)).toBe(true);
    }
  });
});

describe('tx helpers', () => {
  it('applyGasBuffer defaults to 1.2×', () => {
    expect(applyGasBuffer(10_000n)).toBe(12_000n);
    expect(applyGasBuffer(10_000n, 15_000)).toBe(15_000n);
  });

  it('parseExactHash validates length', () => {
    const hash =
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    expect(parseExactHash(hash)).toBe(hash);
    expect(parseExactHash(hash.slice(2))).toBe(hash);
    expect(() => parseExactHash('0xabc')).toThrow(/invalid tx hash/);
  });

  it('classifyTxErr maps common messages', () => {
    expect(classifyTxErr(new Error('user rejected the request'))).toBe('rejected');
    expect(classifyTxErr(new Error('execution reverted'))).toBe('revert');
    expect(classifyTxErr(new Error('network timeout'))).toBe('rpc');
  });

  it('TxError preserves txHash in message', () => {
    const err = new TxError({
      kind: 'rpc',
      op: 'register',
      message: 'timeout',
      txHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    expect(err.txHash).toBeDefined();
    expect(err.message).toContain('query receipt before retrying register');
  });

  it('assertAcceptableReplacement allows repriced and rejects cancel/replace', () => {
    const submitted =
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;
    const replacement =
      '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as const;

    expect(() =>
      assertAcceptableReplacement('register', submitted, undefined),
    ).not.toThrow();
    expect(() =>
      assertAcceptableReplacement('register', submitted, {
        reason: 'repriced',
        transactionHash: replacement,
      }),
    ).not.toThrow();

    expect(() =>
      assertAcceptableReplacement('setAgentURI', submitted, {
        reason: 'cancelled',
        transactionHash: replacement,
      }),
    ).toThrow(TxError);

    try {
      assertAcceptableReplacement('setMetadata', submitted, {
        reason: 'replaced',
        transactionHash: replacement,
      });
      expect.unreachable('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TxError);
      expect((err as TxError).txHash).toBe(submitted);
      expect((err as TxError).message).toContain('different call');
    }
  });

  it('coordinates concurrent nonce allocation for the same account', async () => {
    resetAccountWriteCoordinators();
    const gate = new AccountWriteCoordinator();
    const assigned: number[] = [];
    const known = new Set<`0x${string}`>();

    const hashFor = (nonce: number) =>
      (`0x${nonce.toString(16).padStart(64, '0')}`) as `0x${string}`;

    const tasks = Array.from({ length: 8 }, () =>
      gate.runBroadcast(
        async () => {
          await new Promise((r) => setTimeout(r, 5));
          return { pending: 10, latest: 10 };
        },
        presenceFromMempool(known),
        async (nonce) => {
          assigned.push(nonce);
          const txHash = hashFor(nonce);
          known.add(txHash);
          await new Promise((r) => setTimeout(r, 5));
          return { txHash };
        },
      ),
    );

    const results = await Promise.all(tasks);
    expect(results.map((r) => r.nonce)).toEqual([10, 11, 12, 13, 14, 15, 16, 17]);
    expect(assigned).toEqual([10, 11, 12, 13, 14, 15, 16, 17]);
    for (const r of results) {
      gate.noteSettled(r.nonce);
    }
    expect(gate.peekInFlightNonces()).toEqual([]);
  });

  it('recovers local nonce after broadcast succeeds then tx is dropped', async () => {
    const gate = new AccountWriteCoordinator();
    let pending = 10;
    const latest = 10;
    const mempool = new Map<`0x${string}`, number>();
    const hashFor = (nonce: number) =>
      (`0x${(nonce + 1).toString(16).padStart(64, 'a')}`) as `0x${string}`;

    const first = await gate.runBroadcast(
      async () => ({ pending, latest }),
      presenceFromMempool(mempool),
      async (nonce) => {
        const txHash = hashFor(nonce);
        mempool.set(txHash, nonce);
        // RPC accepted the tx; local next advances even though it is not mined yet.
        pending = nonce + 1;
        return { txHash };
      },
    );
    expect(first.nonce).toBe(10);
    expect(gate.peekLocalNext()).toBe(11);

    // Mempool drop: pending falls back; hash disappears. Wait timeout alone must not free.
    pending = 10;
    mempool.clear();
    expect(gate.peekLocalNext()).toBe(11);

    // Simulate wait failure without receipt — enable drop checks + reconcile.
    await gate.observeAfterWaitFailure(
      first.nonce,
      async () => ({ pending, latest }),
      presenceFromMempool(mempool),
    );
    expect(gate.peekInFlightNonces()).toEqual([]);
    expect(gate.peekLocalNext()).toBe(10);

    const second = await gate.runBroadcast(
      async () => ({ pending, latest }),
      presenceFromMempool(mempool),
      async (nonce) => {
        const txHash = hashFor(nonce);
        mempool.set(txHash, nonce);
        pending = nonce + 1;
        return { txHash };
      },
    );
    expect(second.nonce).toBe(10);
  });

  it('fills dropped lower nonce while a higher in-flight tx remains queryable', async () => {
    const gate = new AccountWriteCoordinator();
    let pending = 10;
    const latest = 10;
    const mempool = new Map<`0x${string}`, number>();
    const hashFor = (nonce: number) =>
      (`0x${(nonce + 3).toString(16).padStart(64, 'c')}`) as `0x${string}`;

    const first = await gate.runBroadcast(
      async () => ({ pending, latest }),
      presenceFromMempool(mempool),
      async (nonce) => {
        const txHash = hashFor(nonce);
        mempool.set(txHash, nonce);
        pending = nonce + 1;
        return { txHash };
      },
    );
    const second = await gate.runBroadcast(
      async () => ({ pending, latest }),
      presenceFromMempool(mempool),
      async (nonce) => {
        const txHash = hashFor(nonce);
        mempool.set(txHash, nonce);
        pending = nonce + 1;
        return { txHash };
      },
    );
    expect(first.nonce).toBe(10);
    expect(second.nonce).toBe(11);
    expect(gate.peekInFlightNonces()).toEqual([10, 11]);

    // Nonce 10 dropped; 11 still known. RPC pending falls back to 10.
    mempool.delete(hashFor(10));
    pending = 10;

    await gate.observeAfterWaitFailure(
      first.nonce,
      async () => ({ pending, latest }),
      presenceFromMempool(mempool),
    );
    expect(gate.peekInFlightNonces()).toEqual([11]);
    expect(gate.peekLocalNext()).toBe(10);

    const third = await gate.runBroadcast(
      async () => ({ pending, latest }),
      presenceFromMempool(mempool),
      async (nonce) => {
        const txHash = hashFor(nonce);
        mempool.set(txHash, nonce);
        pending = Math.max(pending, nonce + 1);
        return { txHash };
      },
    );
    expect(third.nonce).toBe(10);
    expect(gate.peekInFlightNonces()).toEqual([10, 11]);
  });

  it('does not free nonce on wait failure while RPC still knows the tx', async () => {
    const gate = new AccountWriteCoordinator();
    let pending = 10;
    const latest = 10;
    const mempool = new Map<`0x${string}`, number>();
    const hashFor = (nonce: number) =>
      (`0x${(nonce + 2).toString(16).padStart(64, 'b')}`) as `0x${string}`;

    const first = await gate.runBroadcast(
      async () => ({ pending, latest }),
      presenceFromMempool(mempool),
      async (nonce) => {
        const txHash = hashFor(nonce);
        mempool.set(txHash, nonce);
        pending = nonce + 1;
        return { txHash };
      },
    );

    // Wait timed out and pending flipped back, but getTransaction still finds the hash
    // — timeout alone must not open the nonce for reuse.
    pending = 10;
    await gate.observeAfterWaitFailure(
      first.nonce,
      async () => ({ pending, latest }),
      presenceFromMempool(mempool),
    );
    expect(gate.peekInFlightNonces()).toEqual([10]);
    expect(gate.peekLocalNext()).toBe(11);

    const second = await gate.runBroadcast(
      async () => ({ pending, latest }),
      presenceFromMempool(mempool),
      async (nonce) => {
        const txHash = hashFor(nonce);
        mempool.set(txHash, nonce);
        pending = nonce + 1;
        return { txHash };
      },
    );
    expect(second.nonce).toBe(11);
  });

  it('does not allocate below latest when pending lags behind', async () => {
    const gate = new AccountWriteCoordinator();
    const mempool = new Map<`0x${string}`, number>();
    const hashFor = (nonce: number) =>
      (`0x${(nonce + 5).toString(16).padStart(64, 'e')}`) as `0x${string}`;

    // Stale/skewed RPC view: pending still reports 10 while latest has advanced to 11.
    const assigned = await gate.runBroadcast(
      async () => ({ pending: 10, latest: 11 }),
      presenceFromMempool(mempool),
      async (nonce) => {
        const txHash = hashFor(nonce);
        mempool.set(txHash, nonce);
        return { txHash };
      },
    );
    expect(assigned.nonce).toBe(11);
    expect(gate.peekLocalNext()).toBe(12);
  });

  it('does not reuse nonce when getTransaction times out after wait failure', async () => {
    const gate = new AccountWriteCoordinator();
    let pending = 10;
    const latest = 10;
    const mempool = new Map<`0x${string}`, number>();
    const hashFor = (nonce: number) =>
      (`0x${(nonce + 4).toString(16).padStart(64, 'd')}`) as `0x${string}`;

    const first = await gate.runBroadcast(
      async () => ({ pending, latest }),
      presenceFromMempool(mempool),
      async (nonce) => {
        const txHash = hashFor(nonce);
        mempool.set(txHash, nonce);
        pending = nonce + 1;
        return { txHash };
      },
    );

    // Pending lags, and lookup hits a transport/timeout error — must keep reservation.
    pending = 10;
    await gate.observeAfterWaitFailure(
      first.nonce,
      async () => ({ pending, latest }),
      async () => 'unavailable',
    );
    expect(gate.peekInFlightNonces()).toEqual([10]);
    expect(gate.peekLocalNext()).toBe(11);

    const second = await gate.runBroadcast(
      async () => ({ pending, latest }),
      async () => 'unavailable',
      async (nonce) => {
        const txHash = hashFor(nonce);
        mempool.set(txHash, nonce);
        pending = nonce + 1;
        return { txHash };
      },
    );
    expect(second.nonce).toBe(11);
  });

  it('txPresenceFromLookupError only treats TransactionNotFoundError as not_found', () => {
    expect(
      txPresenceFromLookupError(new TransactionNotFoundError({ hash: '0x1' })),
    ).toBe('not_found');
    expect(txPresenceFromLookupError(new Error('timeout'))).toBe('unavailable');
    expect(txPresenceFromLookupError(new Error('429 Too Many Requests'))).toBe(
      'unavailable',
    );
  });
});

describe('IdentityClient.ref', () => {
  it('assembles locator without RPC', async () => {
    const { ref } = await import('../src/read.js');
    const ctx = {
      chain: testnet,
      viemChain: defineChain({
        id: testnet.chainId,
        name: testnet.name,
        nativeCurrency: { name: 'BOT', symbol: 'BOT', decimals: 18 },
        rpcUrls: { default: { http: [testnet.rpcUrl] } },
      }),
      publicClient: {} as never,
      registryAddress: testnet.identityRegistryAddress,
    };
    const identity = ref(ctx, 42n);
    expect(identity.chainId).toBe(968);
    expect(identity.registryAddress).toBe(testnet.identityRegistryAddress);
    expect(identity.agentId).toBe(42n);
  });
});
