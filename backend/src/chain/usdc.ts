/**
 * Arc USDC: verify incoming transfers to the treasury and send payouts.
 * Network (testnet/mainnet) comes from ARC_NETWORK.
 */
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  http,
  keccak256,
  parseEventLogs,
  type Address,
  type Chain,
  type Hash,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arc as arcMainnet, arcTestnet } from 'viem/chains';
import { arc, env } from '../config/env.js';
import { AppError } from '../errors.js';

const chain: Chain = arc.network === 'mainnet' ? arcMainnet : arcTestnet;
const transport = http(arc.rpcUrl, { retryCount: 3, timeout: 15_000 });
const account = privateKeyToAccount(env.TREASURY_PRIVATE_KEY as Hash);

// Arc finalizes in under a second; poll receipts fast so payment checks
// finish in ~1s instead of holding requests open for several.
export const publicClient = createPublicClient({ chain, transport, pollingInterval: 500 });
const walletClient = createWalletClient({ chain, transport, account });

export const treasuryAddress: Address = account.address;
const usdc = getAddress(arc.usdc);

const invalid = (m: string) => new AppError('PAYMENT_INVALID', m);

/**
 * Total USDC (base units) that txHash moved from `from` to the treasury.
 * Throws if the tx is missing, reverted, or moved nothing to us. Callers
 * compare the total with what they expected and refund on mismatch, so a
 * valid payment is never kept without a seat or a refund. Replay protection
 * (one use per hash) is the chain_transfers primary key.
 */
export async function incomingTransferTotal(params: { txHash: Hash; from: string }): Promise<bigint> {
  let receipt;
  try {
    receipt = await publicClient.waitForTransactionReceipt({ hash: params.txHash, timeout: 30_000 });
  } catch {
    throw new AppError('PAYMENT_PENDING', 'payment not confirmed on-chain yet — retrying');
  }
  if (receipt.status !== 'success') throw invalid('transaction reverted');

  const from = getAddress(params.from);
  const total = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: receipt.logs })
    .filter(
      (l) =>
        getAddress(l.address) === usdc &&
        getAddress(l.args.from) === from &&
        getAddress(l.args.to) === treasuryAddress,
    )
    .reduce((sum, l) => sum + l.args.value, 0n);
  if (total === 0n) throw invalid('no USDC transfer from your wallet to the treasury in that transaction');
  return total;
}

/**
 * Sign (but do not broadcast) a USDC transfer from the treasury. Storing the
 * raw tx before broadcasting means a crash or RPC timeout can only ever
 * rebroadcast the same transaction, never send a second one.
 */
export async function signUsdcTransfer(to: string, amount: bigint): Promise<{ raw: Hex; hash: Hash }> {
  return signTreasuryTx(
    usdc,
    encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [getAddress(to), amount] }),
  );
}

/**
 * Sign (but do not broadcast) any treasury contract call. The nonce comes from
 * the chain's pending count, so callers must broadcast each signed tx before
 * signing the next. The single treasury worker does exactly that for both
 * payouts and VRF calls.
 */
export async function signTreasuryTx(to: Address, data: Hex): Promise<{ raw: Hex; hash: Hash }> {
  const request = await walletClient.prepareTransactionRequest({ to, data });
  const raw = await walletClient.signTransaction(request);
  return { raw, hash: keccak256(raw) };
}

export async function broadcast(raw: Hex): Promise<void> {
  await publicClient.sendRawTransaction({ serializedTransaction: raw });
}

export async function transferStatus(hash: Hash): Promise<'success' | 'reverted' | 'unknown'> {
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash });
    return receipt.status;
  } catch {
    return 'unknown';
  }
}

export async function treasuryBalance(): Promise<bigint> {
  return publicClient.readContract({
    address: usdc,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [treasuryAddress],
  });
}
