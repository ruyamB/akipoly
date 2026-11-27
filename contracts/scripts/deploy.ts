/**
 * Deploy AkipolyRounds as a consumer of the hosted Arc VRF
 * (https://arcvrf.007575.xyz/docs), paid from your subscription.
 *
 *   RPC_URL=https://rpc.testnet.arc.io DEPLOYER_PRIVATE_KEY=0x… TREASURY_ADDRESS=0x… VRF_SUBSCRIPTION_ID=… npm run deploy
 *
 * Optional:
 *   VRF_COORDINATOR_ADDRESS / VRF_KEY_HASH   default: Arc VRF on Arc Testnet
 *   CALLBACK_GAS_LIMIT      default 150000 (fulfillRandomWords only stores and emits)
 *   REQUEST_CONFIRMATIONS   default 0 (Arc finalises on inclusion)
 *
 * If the deployer owns the subscription, AkipolyRounds is added as a consumer
 * here; otherwise add it on the Subscriptions page. Prints the backend/.env lines.
 */
import { createPublicClient, createWalletClient, defineChain, getAddress, http, parseAbi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ARC_NETWORKS } from '../../backend/src/shared/arc.js';
import { ARC_VRF_COORDINATOR_ABI } from '../../backend/src/shared/vrf.js';
import { artifact } from '../test/helpers.js';

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`set ${name}`);
  return v;
}

// Required, not defaulted: a forgotten RPC_URL must not quietly deploy to testnet.
const rpcUrl = need('RPC_URL');
const deployer = privateKeyToAccount(need('DEPLOYER_PRIVATE_KEY') as Hex);
const treasury = getAddress(need('TREASURY_ADDRESS'));
const subId = BigInt(need('VRF_SUBSCRIPTION_ID'));
const confirmations = Number(process.env.REQUEST_CONFIRMATIONS ?? 0);
const callbackGasLimit = Number(process.env.CALLBACK_GAS_LIMIT ?? 150_000);

const probe = createPublicClient({ transport: http(rpcUrl) });
const chainId = await probe.getChainId();
const known = Object.values(ARC_NETWORKS).find((n) => n.chainId === chainId)?.vrf ?? null;
const coordinator = getAddress(process.env.VRF_COORDINATOR_ADDRESS ?? known?.coordinator ?? need('VRF_COORDINATOR_ADDRESS'));
const keyHash = (process.env.VRF_KEY_HASH ?? known?.keyHash ?? need('VRF_KEY_HASH')) as Hex;

const chain = defineChain({
  id: chainId,
  name: 'target',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const pub = createPublicClient({ chain, transport: http(rpcUrl) });
const wallet = createWalletClient({ chain, transport: http(rpcUrl), account: deployer });

const subscriptionAbi = parseAbi(ARC_VRF_COORDINATOR_ABI);

console.log(`chain ${chainId}, deployer ${deployer.address}, treasury ${treasury}`);
console.log(`Arc VRF coordinator ${coordinator}, key hash ${keyHash}, subscription ${subId}`);

const [, nativeBalance, , subOwner] = await pub.readContract({
  address: coordinator,
  abi: subscriptionAbi,
  functionName: 'getSubscription',
  args: [subId],
});

const a = artifact('AkipolyRounds');
const hash = await wallet.deployContract({
  abi: a.abi,
  bytecode: a.bytecode,
  args: [coordinator, treasury, keyHash, subId, confirmations, callbackGasLimit],
});
const receipt = await pub.waitForTransactionReceipt({ hash });
if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error(`AkipolyRounds deploy failed (${hash})`);
const rounds = receipt.contractAddress;
console.log(`AkipolyRounds: ${rounds}`);

if (getAddress(subOwner) === deployer.address) {
  const { request } = await pub.simulateContract({
    account: deployer,
    address: coordinator,
    abi: subscriptionAbi,
    functionName: 'addConsumer',
    args: [subId, rounds],
  });
  const r = await pub.waitForTransactionReceipt({ hash: await wallet.writeContract(request) });
  if (r.status !== 'success') throw new Error(`addConsumer failed (${r.transactionHash})`);
  console.log(`added AkipolyRounds as a consumer of subscription ${subId}`);
} else {
  console.log(`\n! Subscription ${subId} is owned by ${subOwner}: add ${rounds} as a consumer on its Subscriptions page.`);
}
if (nativeBalance === 0n) console.log(`! Subscription ${subId} has no USDC yet: fund it before the first game.`);

console.log(`\n# backend/.env
VRF_SUBSCRIPTION_ID=${subId}
VRF_ROUNDS_ADDRESS=${rounds}`);
