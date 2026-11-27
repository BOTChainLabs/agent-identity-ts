/** Thrown when chain_id is not 677 or 968. */
export class UnsupportedChainError extends Error {
  readonly chainId: number;

  constructor(chainId: number) {
    super(`unsupported chain_id ${chainId}: only 677 and 968 are configured`);
    this.name = 'UnsupportedChainError';
    this.chainId = chainId;
  }
}

/** Coarse classification for submit / estimate failures. */
export type TxErrorKind = 'rpc' | 'rejected' | 'revert';

/**
 * Wraps a transaction-path failure.
 * When a transaction was already broadcast, `txHash` is set so callers can
 * recover with `waitMined` / `parseRegisteredReceipt` instead of blindly
 * retrying `register` (which would mint another identity).
 */
export class TxError extends Error {
  readonly kind: TxErrorKind;
  readonly op: string;
  readonly txHash?: `0x${string}`;
  readonly cause?: unknown;

  constructor(opts: {
    kind: TxErrorKind;
    op: string;
    message: string;
    txHash?: `0x${string}`;
    cause?: unknown;
  }) {
    super(
      opts.txHash
        ? `agent-identity: ${opts.op}: ${opts.message} (tx=${opts.txHash}; query receipt before retrying register)`
        : `agent-identity: ${opts.op}: ${opts.message}`,
    );
    this.name = 'TxError';
    this.kind = opts.kind;
    this.op = opts.op;
    if (opts.txHash !== undefined) {
      this.txHash = opts.txHash;
    }
    if (opts.cause !== undefined) {
      this.cause = opts.cause;
    }
  }
}

export function classifyTxErr(err: unknown): TxErrorKind {
  const msg = errorMessage(err).toLowerCase();
  if (
    msg.includes('user rejected') ||
    msg.includes('user denied') ||
    msg.includes('rejected by user') ||
    msg.includes('request rejected') ||
    msg.includes('cancelled') ||
    msg.includes('canceled')
  ) {
    return 'rejected';
  }
  if (
    msg.includes('execution reverted') ||
    msg.includes('invalid opcode') ||
    msg.includes('revert')
  ) {
    return 'revert';
  }
  return 'rpc';
}

export function wrapTx(op: string, err: unknown, txHash?: `0x${string}`): TxError {
  if (err instanceof TxError) {
    if (txHash && !err.txHash) {
      return new TxError({
        kind: err.kind,
        op: err.op || op,
        message: err.message.replace(/^agent-identity: [^:]+: /, ''),
        txHash,
        cause: err.cause ?? err,
      });
    }
    return err;
  }
  return new TxError({
    kind: classifyTxErr(err),
    op,
    message: errorMessage(err),
    ...(txHash !== undefined ? { txHash } : {}),
    cause: err,
  });
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
