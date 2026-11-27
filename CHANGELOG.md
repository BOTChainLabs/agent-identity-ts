# Changelog

## 0.1.0

- Initial Direct SDK: `createClient` for BOT Chain presets `968` / `677`.
- Read: `ownerOf`, `tokenURI`, `getVersion`, `getMetadata`, `getIdentity`, `ref`.
- Write: `register`, `updateURI`, `setMetadata` via Viem `WalletClient` (no hex private key on Client).
- Write safety: assert wallet `eth_chainId` matches SDK chain and pass SDK `chain` to `sendTransaction`; coordinate per-(chain, address) nonce assign + broadcast; assign the lowest free nonce ≥ max(pending, latest) (fill gaps; ignore lagging pending); free in-flight nonces only on explicit `TransactionNotFoundError` (RPC timeout/rate-limit keeps the reservation); pass nonce to Viem for replacement detection; treat cancel/different-call replacements as errors; return mined hash on repriced txs.
- Recovery: `waitMined`, `parseRegisteredReceipt`; `TxError` carries `txHash` after broadcast.
- Examples: `examples/register.ts`, `examples/update.ts`.

### Acceptance notes

- **968 (Bohr testnet):** register／updateURI／setMetadata verified via examples (e.g. agent_id `1004`／`1005`).
- **677 (mainnet):** presets + read path available; write acceptance deferred.
