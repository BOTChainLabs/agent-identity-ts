# agent-identity-ts

BOT Chain **ERC-8004 Direct SDK**（TypeScript / Viem）。开发者用自有 EOA 钱包直连 `IdentityRegistry` 注册／查询／更新 Agent 身份，**不经过** `identity-service` HTTP，不需要项目 API Key。

身份完整定位：`(chain_id, registry_address, agent_id)`。

| 链 | chain ID | IdentityRegistry（proxy） |
| --- | --- | --- |
| Bohr 测试网 | `968` | `0xec8fFbC3c9A34AdDCbB3A14F91db2bd26A8b99c0` |
| BOT 主网 | `677` | `0xB43Edfb9C7609cF645e932B2fF20f26F0d4488dE` |

能力与 [`agent-identity-go`](../agent-identity-go/) 对齐。托管身份仍走 `identity-service`。

## 安装

```bash
npm install @botchainlabs/agent-identity@0.1.0
```

Node.js ≥ 20。公开源码： [agent-identity-ts](https://github.com/BOTChainLabs/agent-identity-ts)。

## 用法

```ts
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createClient, TxError } from '@botchainlabs/agent-identity';

const client = await createClient(968); // 或 { rpcUrl: 'https://...' }
const version = await client.getVersion();
const owner = await client.ownerOf(1n);
const uri = await client.tokenURI(1n);

// 写入：Client 不接收明文私钥。示例侧用 privateKeyToAccount 构造 WalletClient。
const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
const wallet = createWalletClient({
  account,
  chain: client.viemChain(),
  transport: http(),
});

let result;
try {
  result = await client.register(wallet, {
    agentURI: 'https://example.com/agent.json', // 可空
  });
  // result.ref = (chainId, registry, agentId); result.txHash
} catch (err) {
  // 广播后失败：只 throw TxError（带 txHash），不用 (partial, error) 双返回
  if (err instanceof TxError && err.txHash) {
    const receipt = await client.waitMined(err.txHash);
    if (receipt.status !== 'success') {
      throw err; // 已确认失败；勿再 register
    }
    // 仅注册回执才有 Registered；不要对 update 回执调用 parseRegisteredReceipt
    const ref = client.parseRegisteredReceipt(receipt);
    console.log('recovered register', ref, receipt.transactionHash);
    result = { ref, txHash: receipt.transactionHash };
  } else {
    throw err;
  }
}

const newURI = 'https://example.com/agent-v2.json';
try {
  await client.updateURI(wallet, {
    agentId: result.ref.agentId,
    newURI,
  });
} catch (err) {
  if (err instanceof TxError && err.txHash) {
    const receipt = await client.waitMined(err.txHash);
    if (receipt.status !== 'success') throw err;
    // 取消／换成其他调用的替换也可能 status=success；必须核验链上状态
    // 不要 parseRegisteredReceipt（那是注册事件）
    const uri = await client.tokenURI(result.ref.agentId);
    if (uri !== newURI) {
      throw new Error(
        `update not applied after recovery (possible cancel/replace); tokenURI=${uri}`,
      );
    }
    console.log('recovered update', receipt.transactionHash);
  } else {
    throw err;
  }
}
```

浏览器：用 EIP-1193（如 `window.ethereum`）做成 `custom` transport 的 `WalletClient` 再传入；SDK 不内置钱包 UI。写入前 SDK 会校验钱包链 ID，并强制使用 `createClient` 的目标链广播。

## 错误约定

- 不支持的 `chainId` → `UnsupportedChainError`
- 写入路径 → `TxError`（`kind`: `rpc` | `rejected` | `revert`）；已广播时带 `txHash`
- 异步 API 为 `Promise`；失败 `throw`（对齐 Go 的 error；广播后恢复靠 `txHash` + `waitMined`／`parseRegisteredReceipt`）
- 钱包取消或换成其他调用的同 nonce 替换 → `TxError`（不误报成功）；仅同调用加速（repriced）时返回实际上链 `txHash`
- SDK 在同进程内按 `(chainId, address)` 串行分配 nonce 并广播；广播后会跟踪 in-flight，并在等回执失败时用 pending + `getTransaction` 对账（超时本身不等于丢弃），避免 mempool 丢弃后本地只增不减留下缺口。对外的 `waitMined(txHash)` 只有 hash：若节点已丢弃该交易且替换已上链，可能只表现为超时——此时先查浏览器／账户 nonce，**不要**盲重试 `register`。进程外并发仍可能争用 nonce

## 快速检查

```bash
cp .env.example .env
# 在 .env 填测试网 PRIVATE_KEY（不要提交）

npm install
npm test
npm run build

set -a && source .env && set +a
npx tsx examples/register.ts
# 只读：AGENT_IDENTITY_AGENT_ID=1 npx tsx examples/register.ts
NEW_AGENT_URI=https://example.com/agent-v2.json npx tsx examples/update.ts
```

## ABI

权威来源：`../erc-8004-contracts/abis/IdentityRegistry.json`（与 identity-service / Go SDK 同源）。副本在 `src/abi/IdentityRegistry.json`；合约升级后先更新 JSON，再同步三处仓库。

## 状态

- `0.1.0`：968／677 预设与 API 齐；**968 写入已验收**（register／updateURI／setMetadata）；677 写入另排期。
