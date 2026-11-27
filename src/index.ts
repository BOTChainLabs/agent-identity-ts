/** BOT Chain ERC-8004 IdentityRegistry Direct SDK. */

export {
  MAINNET_CHAIN_ID,
  TESTNET_CHAIN_ID,
  mainnet,
  testnet,
  byChainId,
  isSupportedChainId,
  type ChainConfig,
  type SupportedChainId,
} from './chains.js';

export {
  UnsupportedChainError,
  TxError,
  type TxErrorKind,
} from './errors.js';

export {
  createClient,
  IdentityClient,
  type CreateClientOptions,
} from './client.js';

export type {
  IdentityRef,
  RegisterResult,
  MetadataEntry,
  TxParams,
  RegisterParams,
  UpdateURIParams,
  UpdateURIResult,
  SetMetadataParams,
  SetMetadataResult,
} from './types.js';

export { identityRegistryAbi } from './abi/IdentityRegistry.js';

export {
  applyGasBuffer,
  assertAcceptableReplacement,
  DEFAULT_GAS_BUFFER_BPS,
  parseExactHash,
  txPresenceFromLookupError,
  type AccountNonceState,
  type TxPresence,
} from './tx.js';
