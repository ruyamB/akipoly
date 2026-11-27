/**
 * VRF draws via the hosted Arc VRF: one job per round, run by the single
 * treasury worker.
 *
 *   pending ──sign+broadcast requestBall──▶ requested
 *   requested ──Arc VRF delivers (AkipolyRounds.drawOf fulfilled)──▶ done (round: drawing → rolling)
 *   any ──reverted / request tx stuck far too long / callback failed / round voided──▶ held (needs a human)
 *
 * Each pass moves every open job at most one step without blocking, so many
 * tables can be drawing at once. A round is never requested a second time:
 * there is no cancel and no re-request (Arc VRF rule: re-requesting a slow
 * answer would let someone pick the result). A draw that never arrives voids
 * the round at its deadline (services/game.ts) and is never silently replaced.
 */
import type pg from 'pg';
import { keccak256, type Hash, type Hex } from 'viem';
import { env } from '../config/env.js';
import { afterCommit, pool, withTx } from '../db/pool.js';
import { broadcast, publicClient } from '../chain/usdc.js';
import { coordinatorAddress, findFailedCallbacks, findFulfillTx, parseRequest, readDraw, roundsAddress, signRequestBall } from '../chain/vrf.js';
import { events, lobbyChanged } from '../events.js';
import { log } from '../log.js';

const ACTIVE_POLL_MS = 250;
const REBROADCAST_AFTER_MS = 15_000;
const HOLD_AFTER_MS = 10 * 60_000;
/** How often to look for failed callbacks (one eth_getLogs for all waiting jobs). */
const FAILURE_SCAN_MS = 10_000;

type JobStatus = 'pending' | 'requested' | 'done' | 'held';

interface JobRow {
  round_id: string;
  game_id: string;
  lobby_id: string;
  round_number: number;
  status: JobStatus;
  request_tx: Hash | null;
  request_raw: Hex | null;
  request_id: string | null;
  request_block: bigint | null;
  updated_at: Date;
}

/** Thrown when a signed tx could not be broadcast: stop this pass so no later tx reuses its nonce. */
class BroadcastFailed extends Error {}
/** The signed tx's nonce was used by a different transaction: this raw tx can never land. */
class NonceConsumed extends Error {}

/** Last rebroadcast per job, so a stuck tx is resent every REBROADCAST_AFTER_MS, not every pass. */
const lastRebroadcast = new Map<string, number>();

/** Queue the draw for a round that just entered 'drawing'. Call inside the same tx. */
export async function enqueueVrfDraw(c: pg.PoolClient, roundId: string, gameId: string, roundNumber: number) {
  await c.query(
    `insert into public.vrf_jobs (round_id, game_id, round_number) values ($1, $2, $3) on conflict do nothing`,
    [roundId, gameId, roundNumber],
  );
  afterCommit(c, () => events.emit('vrf'));
}

async function send(raw: Hex): Promise<void> {
  try {
    await broadcast(raw);
  } catch (err) {
    const msg = String(err).toLowerCase();
    // Already in the pool: fine.
    if (msg.includes('already known') || msg.includes('already imported')) return;
    // Nonce used: fine only if it was used by THIS tx; otherwise it can never land.
    if (msg.includes('nonce too low')) {
      const hash = keccak256(raw);
      const seen = await publicClient.getTransaction({ hash }).catch(() => null);
      if (seen) return;
      throw new NonceConsumed(`nonce of ${hash} was used by another transaction`);
    }
    throw new BroadcastFailed(String(err));
  }
}

async function receiptOf(hash: Hash) {
  try {
    return await publicClient.getTransactionReceipt({ hash });
  } catch {
    return null; // not mined (or not seen) yet
  }
}

async function hold(job: JobRow, reason: string): Promise<void> {
  await pool.query(
    `update public.vrf_jobs set status = 'held', last_error = $2, updated_at = now() where round_id = $1`,
    [job.round_id, reason.slice(0, 500)],
  );
  lastRebroadcast.delete(job.round_id);
  log.error({ roundId: job.round_id, gameId: job.game_id, round: job.round_number, reason }, 'VRF draw held for review');
}

/** Rebroadcast a tx that hasn't landed; hold the job once it is hopeless. Returns true if held. */
async function nudge(job: JobRow, raw: Hex): Promise<boolean> {
  const age = Date.now() - job.updated_at.getTime();
  if (age > HOLD_AFTER_MS) {
    await hold(job, `${job.status} tx not mined in ${HOLD_AFTER_MS / 60_000} min`);
    return true;
  }
  const now = Date.now();
  if (age > REBROADCAST_AFTER_MS && now - (lastRebroadcast.get(job.round_id) ?? 0) > REBROADCAST_AFTER_MS) {
    lastRebroadcast.set(job.round_id, now);
    await send(raw);
  }
  return false;
}

type Draw = Awaited<ReturnType<typeof readDraw>>;

async function step(job: JobRow, prefetched: Draw | null, failed: Set<bigint>): Promise<void> {
  if (job.status === 'pending') {
    const { raw, hash } = await signRequestBall(job.game_id, job.round_number);
    await pool.query(
      `update public.vrf_jobs set status = 'requested', request_tx = $2, request_raw = $3,
              attempts = attempts + 1, updated_at = now()
        where round_id = $1 and status = 'pending'`,
      [job.round_id, hash, raw],
    );
    await send(raw);
    log.info({ gameId: job.game_id, round: job.round_number, tx: hash }, 'VRF requested');
    return;
  }

  if (job.status !== 'requested') return;

  if (!job.request_id) {
    const receipt = await receiptOf(job.request_tx!);
    if (!receipt) {
      await nudge(job, job.request_raw!);
      return;
    }
    if (receipt.status !== 'success') return hold(job, `requestBall reverted (${job.request_tx})`);
    const req = parseRequest(receipt);
    if (!req) return hold(job, `no BallRequested in ${job.request_tx}`);
    await pool.query(
      `update public.vrf_jobs set request_id = $2, request_block = $3, updated_at = now() where round_id = $1`,
      [job.round_id, req.requestId.toString(), req.blockNumber],
    );
    job.request_id = req.requestId.toString();
    job.request_block = req.blockNumber;
  }

  // Waiting on the Arc VRF: its answer lands in AkipolyRounds.drawOf.
  const draw = prefetched ?? (await readDraw(job.game_id, job.round_number));
  if (!draw.fulfilled) {
    if (failed.has(BigInt(job.request_id))) {
      return hold(job, 'Arc VRF callback failed (raise callbackGasLimit with AkipolyRounds.setRequestParams)');
    }
    return;
  }
  if (draw.requestId !== BigInt(job.request_id)) {
    return hold(job, `drawOf requestId ${draw.requestId} differs from ours ${job.request_id}`);
  }
  const fulfillTx = await findFulfillTx(job.game_id, job.round_number, job.request_block!).catch(() => null);
  return finish(job, draw.ball, draw.randomWord, fulfillTx);
}

/** Record the on-chain ball and start the roll. */
async function finish(job: JobRow, ball: number, randomWord: bigint, fulfillTx: Hash | null): Promise<void> {
  await withTx(async (c) => {
    await c.query(
      `update public.rounds
          set phase = 'rolling', ball = $2, phase_ends_at = now() + $3::interval,
              vrf_request_id = $4, vrf_request_tx = $5, vrf_request_block = $6,
              vrf_fulfill_tx = $7, vrf_random_word = $8, vrf_rounds_address = $9, vrf_coordinator = $10
        where id = $1 and phase = 'drawing'`,
      [
        job.round_id,
        ball,
        `${env.ROLLING_MS} milliseconds`,
        job.request_id,
        job.request_tx,
        job.request_block,
        fulfillTx,
        randomWord.toString(),
        roundsAddress,
        coordinatorAddress,
      ],
    );
    await c.query(`update public.vrf_jobs set status = 'done', updated_at = now() where round_id = $1`, [job.round_id]);
    afterCommit(c, () => lobbyChanged(job.lobby_id)); // also wakes the scheduler
  });
  lastRebroadcast.delete(job.round_id);
  log.info({ gameId: job.game_id, round: job.round_number, ball }, 'ball drawn on-chain');
}

export interface VrfPass {
  /** ms until the worker should look again; null = nothing open. */
  delay: number | null;
  /**
   * A signed tx failed to broadcast and still owns the next nonce: the caller
   * must not sign anything else (payouts included) until it is rebroadcast.
   */
  blocked: boolean;
}

let lastFailureScan = 0;

/** Callbacks the coordinator reported as failed, among these unanswered jobs. Throttled. */
async function failedCallbacks(jobs: JobRow[]): Promise<Set<bigint>> {
  if (jobs.length === 0 || Date.now() - lastFailureScan < FAILURE_SCAN_MS) return new Set();
  lastFailureScan = Date.now();
  const from = jobs.reduce((m, j) => (j.request_block! < m ? j.request_block! : m), jobs[0]!.request_block!);
  return findFailedCallbacks(
    jobs.map((j) => BigInt(j.request_id!)),
    from,
  );
}

/** Advance every open VRF job by one step. */
export async function runVrfJobs(): Promise<VrfPass> {
  const { rows } = await pool.query<JobRow>(
    `select j.round_id, j.game_id, g.lobby_id, j.round_number, j.status, j.request_tx, j.request_raw,
            j.request_id, j.request_block, j.updated_at
       from public.vrf_jobs j join public.games g on g.id = j.game_id
      where j.status in ('pending', 'requested') and j.next_attempt_at <= now()
      order by j.created_at
      limit 50`,
  );
  if (rows.length === 0) {
    const next = await pool.query<{ at: Date | null }>(
      `select min(next_attempt_at) as at from public.vrf_jobs where status in ('pending', 'requested')`,
    );
    const at = next.rows[0]?.at;
    return { delay: at ? Math.max(0, at.getTime() - Date.now()) : null, blocked: false };
  }

  // Read every waiting draw at once rather than one RPC per job in turn.
  const waiting = rows.filter((j) => j.status === 'requested' && j.request_id);
  const draws = new Map(
    await Promise.all(
      waiting.map(async (j) => [j.round_id, await readDraw(j.game_id, j.round_number).catch(() => null)] as const),
    ),
  );
  const failed = await failedCallbacks(waiting.filter((j) => draws.get(j.round_id)?.fulfilled === false)).catch(
    (err: unknown) => {
      log.warn({ err }, 'failed-callback scan failed');
      return new Set<bigint>();
    },
  );

  for (const job of rows) {
    try {
      await step(job, draws.get(job.round_id) ?? null, failed);
    } catch (err) {
      if (err instanceof BroadcastFailed) {
        log.warn({ err, roundId: job.round_id }, 'VRF broadcast failed, will retry');
        return { delay: ACTIVE_POLL_MS * 4, blocked: true };
      }
      if (err instanceof NonceConsumed) {
        await hold(job, err.message);
        continue;
      }
      await pool.query(
        `update public.vrf_jobs
            set attempts = attempts + 1, last_error = $2, updated_at = updated_at,
                next_attempt_at = now() + interval '2 seconds'
          where round_id = $1`,
        [job.round_id, String(err).slice(0, 500)],
      );
      log.error({ err, roundId: job.round_id, status: job.status }, 'VRF step failed');
    }
  }
  return { delay: ACTIVE_POLL_MS, blocked: false };
}
