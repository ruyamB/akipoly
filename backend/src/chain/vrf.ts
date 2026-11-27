/**
 * Arc VRF on Arc: the treasury asks AkipolyRounds for a ball, the hosted Arc VRF
 * (https://arcvrf.007575.xyz) proves and delivers the word, and we read the
 * on-chain result back. This server never holds a VRF key or fulfils anything.
 */
import {
  BaseError,
  HttpRequestError,
  RpcRequestError,
  TimeoutError,
  encodeFunctionData,
  getAddress,
  parseAbi,
  parseEventLogs,
  type Address,
  type Hash,
  type Hex,
  type TransactionReceipt,
} from 'viem';
import { arc, env } from '../config/env.js';
import { AKIPOLY_ROUNDS_ABI, ARC_VRF_COORDINATOR_ABI, gameIdToBytes16 } from '../shared/vrf.js';
import { publicClient, signTreasuryTx, treasuryAddress } from './usdc.js';

export const roundsAbi = parseAbi(AKIPOLY_ROUNDS_ABI);
const coordinatorAbi = parseAbi(ARC_VRF_COORDINATOR_ABI);

export const roundsAddress: Address = getAddress(env.VRF_ROUNDS_ADDRESS);
export const coordinatorAddress: Address = getAddress(arc.vrf.coordinator);

/** Below this native balance the subscription may stop paying for draws (warn only). */
const LOW_SUBSCRIPTION_BALANCE = 10n ** 17n; // 0.1 USDC (native, 18 decimals)

export function signRequestBall(gameId: string, roundNumber: number): Promise<{ raw: Hex; hash: Hash }> {
  return signTreasuryTx(
    roundsAddress,
    encodeFunctionData({ abi: roundsAbi, functionName: 'requestBall', args: [gameIdToBytes16(gameId), roundNumber] }),
  );
}

/** The requestId AkipolyRounds got from the coordinator, from its BallRequested log. */
export function parseRequest(receipt: TransactionReceipt): { requestId: bigint; blockNumber: bigint } | null {
  const ev = parseEventLogs({ abi: roundsAbi, eventName: 'BallRequested', logs: receipt.logs }).find(
    (l) => getAddress(l.address) === roundsAddress,
  );
  return ev ? { requestId: ev.args.requestId, blockNumber: receipt.blockNumber } : null;
}

/** The on-chain record of a round's draw, read straight from AkipolyRounds. */
export async function readDraw(gameId: string, roundNumber: number) {
  return publicClient.readContract({
    address: roundsAddress,
    abi: roundsAbi,
    functionName: 'drawOf',
    args: [gameIdToBytes16(gameId), roundNumber],
  });
}

/** Log scans stop this many blocks after the request; an answer later than that is not looked for. */
const LOG_WINDOW = 5_000n;

async function logRange(fromBlock: bigint) {
  const head = await publicClient.getBlockNumber();
  const toBlock = fromBlock + LOG_WINDOW < head ? fromBlock + LOG_WINDOW : head;
  return { fromBlock, toBlock };
}

/** The tx in which the Arc VRF delivered this round's ball (for the review's links). */
export async function findFulfillTx(gameId: string, roundNumber: number, fromBlock: bigint): Promise<Hash | null> {
  const logs = await publicClient.getContractEvents({
    address: roundsAddress,
    abi: roundsAbi,
    eventName: 'BallDrawn',
    args: { gameId: gameIdToBytes16(gameId), round: roundNumber },
    ...(await logRange(fromBlock)),
  });
  return logs[0]?.transactionHash ?? null;
}

/**
 * Request ids (of `requestIds`) the coordinator answered but whose callback
 * failed (reverted / out of gas): those draws will never land in drawOf.
 */
export async function findFailedCallbacks(requestIds: bigint[], fromBlock: bigint): Promise<Set<bigint>> {
  if (requestIds.length === 0) return new Set();
  const logs = await publicClient.getContractEvents({
    address: coordinatorAddress,
    abi: coordinatorAbi,
    eventName: 'RandomWordsFulfilled',
    args: { requestId: requestIds },
    ...(await logRange(fromBlock)),
  });
  return new Set(logs.filter((l) => l.args.success === false).map((l) => l.args.requestId!));
}

/**
 * Refuse to run a treasury worker against a mis-wired deployment: wrong
 * requester, coordinator, key hash, subscription, or AkipolyRounds missing from
 * the subscription's consumers would strand every round in 'drawing'.
 */
export async function checkVrfSetup(): Promise<{ mismatches: string[]; warnings: string[]; unreachable: string | null }> {
  const problems: string[] = [];
  const warnings: string[] = [];
  let unreachable: string | null = null;
  // Transport failures (RPC down, timeout) are retryable; anything else (no
  // contract at the address, wrong ABI) means the deployment is wrong.
  const isTransport = (err: unknown) =>
    err instanceof BaseError &&
    !!err.walk((e) => e instanceof HttpRequestError || e instanceof TimeoutError || e instanceof RpcRequestError);
  const read = <T>(p: Promise<T>) =>
    p.catch((err: unknown) => {
      if (isTransport(err)) unreachable ??= String(err);
      else problems.push(String(err));
      return null;
    });
  const subId = arc.vrf.subscriptionId;
  const [requester, coordinator, keyHash, roundsSubId, subscription, provingKey] = await Promise.all([
    read(publicClient.readContract({ address: roundsAddress, abi: roundsAbi, functionName: 'requester' })),
    read(publicClient.readContract({ address: roundsAddress, abi: roundsAbi, functionName: 'COORDINATOR' })),
    read(publicClient.readContract({ address: roundsAddress, abi: roundsAbi, functionName: 'keyHash' })),
    read(publicClient.readContract({ address: roundsAddress, abi: roundsAbi, functionName: 'subId' })),
    read(
      publicClient.readContract({
        address: coordinatorAddress,
        abi: coordinatorAbi,
        functionName: 'getSubscription',
        args: [subId],
      }),
    ),
    read(
      publicClient.readContract({
        address: coordinatorAddress,
        abi: coordinatorAbi,
        functionName: 's_provingKeys',
        args: [arc.vrf.keyHash],
      }),
    ),
  ]);
  if (problems.length || unreachable) return { mismatches: problems, warnings, unreachable };

  if (getAddress(requester!) !== treasuryAddress)
    problems.push(`AkipolyRounds.requester is ${requester}, not the treasury ${treasuryAddress}`);
  if (getAddress(coordinator!) !== coordinatorAddress)
    problems.push(`AkipolyRounds.COORDINATOR is ${coordinator}, expected the Arc VRF coordinator ${coordinatorAddress}`);
  if (keyHash!.toLowerCase() !== arc.vrf.keyHash.toLowerCase())
    problems.push(`AkipolyRounds.keyHash ${keyHash} does not match ${arc.vrf.keyHash}`);
  if (!provingKey![0]) problems.push(`key hash ${arc.vrf.keyHash} is not registered on coordinator ${coordinatorAddress}`);
  if (roundsSubId !== subId)
    problems.push(`AkipolyRounds.subId is ${roundsSubId}, VRF_SUBSCRIPTION_ID is ${subId}`);
  const [, nativeBalance, , , consumers] = subscription!;
  if (!consumers.some((c) => getAddress(c) === roundsAddress))
    problems.push(`AkipolyRounds ${roundsAddress} is not a consumer of Arc VRF subscription ${subId} (add it on the Subscriptions page)`);
  if (nativeBalance < LOW_SUBSCRIPTION_BALANCE)
    warnings.push(`Arc VRF subscription ${subId} has only ${nativeBalance} wei of USDC left: top it up or draws will fail`);
  return { mismatches: problems, warnings, unreachable: null };
}
