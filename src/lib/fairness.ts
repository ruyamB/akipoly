/**
 * Browser-side fairness checks.
 *
 * VRF rounds (current): the ball was decided on Arc. The coordinator verified
 * the VRF proof on-chain, and AkipolyRounds stored
 *   ball = randomWord % 17
 * We read that record straight from the chain (not from our server), and check
 * that it matches the ball and word the server reported.
 *
 * Legacy rounds (before the VRF switch): commit-reveal.
 *   sha256(seed) === seedHash
 *   ball === uint64(HMAC-SHA256(seed, `${gameId}:${round}`)[0..8]) mod 17
 */
// Dependency-free on purpose (no viem / ./arc import), so Node tests can run it:
// callers pass in how to read AkipolyRounds.drawOf (src/lib/arc.ts readRoundDraw).
// Relative paths, not @shared/*: backend/test/fairness-client.test.ts and
// contracts/test/backend-draw.test.ts run this file under their own tsx,
// which doesn't know the site's alias.
import { BALL_MAX, BALL_MIN } from '../../backend/src/shared/constants';
import type { RoundVrf } from '../../backend/src/shared/protocol';
import { ballFromRandomWord } from '../../backend/src/shared/vrf';

/** AkipolyRounds.drawOf(gameId, round) as read from the chain. */
export interface OnChainDraw {
  requestId: bigint;
  randomWord: bigint;
  fulfilled: boolean;
  ball: number;
}
export type ReadDraw = (gameId: string, roundNumber: number) => Promise<OnChainDraw>;

export type VrfCheck =
  /** chain record matches the reported ball and word */
  | 'verified'
  /** chain says something different: the server's report is wrong */
  | 'mismatch'
  /** couldn't reach the chain (RPC down / offline) */
  | 'unavailable';

export async function verifyVrfRound(
  readDraw: ReadDraw,
  gameId: string,
  roundNumber: number,
  ball: number,
  vrf: RoundVrf,
): Promise<VrfCheck> {
  // Local arithmetic check first: the word really does give this ball.
  if (ballFromRandomWord(BigInt(vrf.randomWord)) !== ball) return 'mismatch';
  let draw: OnChainDraw;
  try {
    draw = await readDraw(gameId, roundNumber);
  } catch {
    return 'unavailable';
  }
  const ok =
    draw.fulfilled &&
    draw.ball === ball &&
    draw.randomWord === BigInt(vrf.randomWord) &&
    draw.requestId === BigInt(vrf.requestId);
  return ok ? 'verified' : 'mismatch';
}

// ---------------------------------------------------------------- legacy
const enc = new TextEncoder();
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function deriveBall(seed: string, gameId: string, roundNumber: number): Promise<number> {
  const key = await crypto.subtle.importKey('raw', enc.encode(seed), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, enc.encode(`${gameId}:${roundNumber}`));
  const n = new DataView(digest).getBigUint64(0, false);
  return BALL_MIN + Number(n % BigInt(BALL_MAX - BALL_MIN + 1));
}

/** Commit-reveal check for games played before the VRF switch. */
export async function verifyLegacyRound(
  seed: string,
  seedHash: string,
  gameId: string,
  roundNumber: number,
  ball: number,
): Promise<{ hashOk: boolean; ballOk: boolean }> {
  const [hash, derived] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(seed)).then(hex),
    deriveBall(seed, gameId, roundNumber),
  ]);
  return { hashOk: hash === seedHash, ballOk: derived === ball };
}
