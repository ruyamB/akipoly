/**
 * VRF pieces shared by the backend and the web client. Dependency-free (no
 * viem import) so the frontend can use it too: pass the ABI strings to
 * viem's parseAbi.
 *
 * The ball is decided on-chain by AkipolyRounds:
 *     ball = BALL_MIN + randomWord % 17
 * where randomWord is delivered by the hosted Arc VRF coordinator after it
 * verified the VRF proof on-chain (https://arcvrf.007575.xyz).
 */
import { BALL_MAX, BALL_MIN } from './constants.js';

export const BALL_RANGE = BigInt(BALL_MAX - BALL_MIN + 1);

/** Same arithmetic as AkipolyRounds.fulfillRandomWords. */
export function ballFromRandomWord(randomWord: bigint): number {
  return BALL_MIN + Number(randomWord % BALL_RANGE);
}

/** A game's uuid as the bytes16 the contract keys rounds by. */
export function gameIdToBytes16(gameId: string): `0x${string}` {
  const hex = gameId.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error(`not a uuid: ${gameId}`);
  return `0x${hex}`;
}

/** Human-readable ABI of AkipolyRounds (the part the game uses). */
export const AKIPOLY_ROUNDS_ABI = [
  'struct Draw { uint256 requestId; uint256 randomWord; uint64 requestedAt; bool fulfilled; uint8 ball; }',
  'function requestBall(bytes16 gameId, uint32 round) returns (uint256 requestId)',
  'function drawOf(bytes16 gameId, uint32 round) view returns (Draw)',
  'function ballOf(bytes16 gameId, uint32 round) view returns (bool fulfilled, uint8 ball)',
  'function requester() view returns (address)',
  'function keyHash() view returns (bytes32)',
  'function subId() view returns (uint256)',
  'function requestConfirmations() view returns (uint16)',
  'function COORDINATOR() view returns (address)',
  'event BallRequested(bytes16 indexed gameId, uint32 indexed round, uint256 requestId)',
  'event BallDrawn(bytes16 indexed gameId, uint32 indexed round, uint256 requestId, uint256 randomWord, uint8 ball)',
] as const;

/** Human-readable ABI of the hosted Arc VRF coordinator (backend reads, deploy script adds the consumer). */
export const ARC_VRF_COORDINATOR_ABI = [
  'function getSubscription(uint256 subId) view returns (uint96 balance, uint96 nativeBalance, uint64 reqCount, address owner, address[] consumers)',
  'function addConsumer(uint256 subId, address consumer)',
  'function s_provingKeys(bytes32 keyHash) view returns (bool exists, uint64 maxGas)',
  // success=false: the consumer callback reverted or ran out of gas, and the request is gone.
  'event RandomWordsFulfilled(uint256 indexed requestId, uint256 outputSeed, uint256 indexed subId, uint96 payment, bool nativePayment, bool success, bool onlyPremium)',
] as const;

/** Public proof page for a request on the Arc VRF explorer. */
export const vrfProofUrl = (explorerUrl: string, requestId: string | bigint) =>
  `${explorerUrl.replace(/\/$/, '')}/requests/${requestId}`;
