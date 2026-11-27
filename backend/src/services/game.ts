/**
 * Game state machine. Every round row moves betting → drawing → rolling → settled.
 * The scheduler advances betting and rolling rows whose phase_ends_at has passed.
 * A drawing row moves on only when the on-chain VRF has answered (services/vrf.ts).
 *
 *   round 0 (opening): drawing → rolling → settled          (draws the first ball)
 *   round n:           betting → drawing → rolling → settled (call, draw, roll, settle)
 *
 * The ball is requested only after betting closes, and nobody can know it
 * before then, the server included. Chainlink's rule: accept no inputs once
 * randomness has been requested.
 */
import type pg from 'pg';
import type { Hash } from 'viem';
import { env } from '../config/env.js';
import { withTx } from '../db/pool.js';
import {
  isGameOver,
  isPickPossible,
  placementFor,
  resolveRound,
  settlePot,
  settleSideBets,
  type PickInput,
} from '../domain/rules.js';
import { incomingTransferTotal } from '../chain/usdc.js';
import { AppError, badRequest, conflict, notFound } from '../errors.js';
import { lobbyChanged } from '../events.js';
import { log } from '../log.js';
import { enqueuePayouts, recordTransfer } from './payouts.js';
import { enqueueVrfDraw } from './vrf.js';
import type { Direction } from '../shared/protocol.js';

const BETTING_MS = env.BETTING_SECONDS * 1000;
const ms = (n: number) => `${n} milliseconds`;

export interface RoundRow {
  id: string;
  game_id: string;
  lobby_id: string;
  pot: bigint;
  round_number: number;
  phase: 'betting' | 'drawing' | 'rolling' | 'settled';
  prev_ball: number | null;
  ball: number | null;
  phase_ends_at: Date;
}

/** Create the game for a lobby whose countdown finished. Lobby row must be locked. */
export async function startGame(c: pg.PoolClient, lobbyId: string, buyIn: bigint): Promise<string | null> {
  const players = (
    await c.query<{ user_id: string; display_name: string }>(
      `select user_id, display_name from public.lobby_players where lobby_id = $1 and ready order by joined_at`,
      [lobbyId],
    )
  ).rows;
  const seated = Number(
    (await c.query<{ n: bigint }>('select count(*) as n from public.lobby_players where lobby_id = $1', [lobbyId]))
      .rows[0]!.n,
  );
  if (players.length < 2 || players.length !== seated) {
    await c.query(`update public.lobbies set status = 'waiting', starts_at = null, updated_at = now() where id = $1`, [
      lobbyId,
    ]);
    return null;
  }

  const gameId = (
    await c.query<{ id: string }>(`insert into public.games (lobby_id, pot) values ($1, $2) returning id`, [
      lobbyId,
      buyIn * BigInt(players.length),
    ])
  ).rows[0]!.id;
  await c.query(
    `insert into public.game_players (game_id, user_id, display_name, buy_in)
     select $1, u, n, $4 from unnest($2::text[], $3::text[]) as t(u, n)`,
    [gameId, players.map((p) => p.user_id), players.map((p) => p.display_name), buyIn],
  );
  await c.query(`update public.lobbies set status = 'live', starts_at = null, updated_at = now() where id = $1`, [
    lobbyId,
  ]);

  // The opening ball comes from the VRF like every other ball.
  const roundId = (
    await c.query<{ id: string }>(
      `insert into public.rounds (game_id, round_number, phase, phase_ends_at)
       values ($1, 0, 'drawing', now() + $2::interval) returning id`,
      [gameId, ms(env.VRF_DRAW_TIMEOUT_MS)],
    )
  ).rows[0]!.id;
  await enqueueVrfDraw(c, roundId, gameId, 0);
  return gameId;
}

async function openRound(c: pg.PoolClient, gameId: string, roundNumber: number, prevBall: number) {
  await c.query(
    `insert into public.rounds (game_id, round_number, phase, prev_ball, phase_ends_at)
     values ($1, $2, 'betting', $3, now() + $4::interval)`,
    [gameId, roundNumber, prevBall, ms(BETTING_MS)],
  );
}

/**
 * Advance a due round by one phase. Round row must be locked.
 * Returns whether this finished the game (the lobby list then changes too).
 */
export async function advanceRound(c: pg.PoolClient, round: RoundRow): Promise<{ finished: boolean }> {
  if (round.phase === 'betting') {
    // Calls are closed. Only now ask the chain for the ball; the VRF worker
    // moves the round to 'rolling' once the proof has been verified on-chain.
    // phase_ends_at is the deadline: if the VRF hasn't answered by then, the
    // scheduler voids the round (voidUndrawnRound).
    await c.query(`update public.rounds set phase = 'drawing', phase_ends_at = now() + $2::interval where id = $1`, [
      round.id,
      ms(env.VRF_DRAW_TIMEOUT_MS),
    ]);
    await enqueueVrfDraw(c, round.id, round.game_id, round.round_number);
    return { finished: false };
  }
  if (round.phase === 'drawing') return { finished: await voidUndrawnRound(c, round) };
  return { finished: round.phase === 'rolling' && (await settleRound(c, round)) };
}

/**
 * The VRF didn't deliver a ball before the deadline (oracle down, tx stuck or
 * reverted, job held). Nobody gains from this: the round is void, side bets are
 * refunded and nobody is out, as with any other void round. A missing opening
 * ball ends the game and returns the pot without a house fee. The open VRF job
 * is held for operators, so it stops being polled (if the answer still lands
 * on-chain, it is simply unused).
 * Returns true when this ended the game.
 */
async function voidUndrawnRound(c: pg.PoolClient, round: RoundRow): Promise<boolean> {
  await c.query(
    `update public.vrf_jobs
        set status = case when status in ('pending', 'requested') then 'held' else status end,
            last_error = coalesce(last_error, 'round voided: no VRF answer before the deadline'),
            updated_at = now()
      where round_id = $1`,
    [round.id],
  );
  await c.query(`update public.rounds set phase = 'settled', outcome = 'void' where id = $1`, [round.id]);
  log.error({ gameId: round.game_id, round: round.round_number }, 'VRF did not answer in time, round voided');

  const alive = (
    await c.query<{ user_id: string }>(
      `select user_id from public.game_players where game_id = $1 and eliminated_round is null`,
      [round.game_id],
    )
  ).rows.map((r) => r.user_id);

  if (round.round_number === 0) {
    await finishGame(c, round, alive, alive, 0);
    return true;
  }

  const picks: PickInput[] = (
    await c.query<{ user_id: string; direction: Direction; side_bet: bigint }>(
      `select user_id, direction, side_bet from public.picks where round_id = $1`,
      [round.id],
    )
  ).rows.map((p) => ({ userId: p.user_id, direction: p.direction, sideBet: p.side_bet }));
  await enqueuePayouts(
    c,
    settleSideBets(picks, 'void', env.HOUSE_FEE_BPS).map((p) => ({
      key: `side:${round.id}:${p.userId}`,
      userId: p.userId,
      amount: p.amount,
      reason: p.reason,
      gameId: round.game_id,
    })),
  );

  if (isGameOver(alive.length, round.round_number, env.MAX_ROUNDS)) {
    await finishGame(c, round, alive, alive);
    return true;
  }
  await openRound(c, round.game_id, round.round_number + 1, round.prev_ball!);
  return false;
}

/** Returns true when this round ended the game. */
async function settleRound(c: pg.PoolClient, round: RoundRow): Promise<boolean> {
  const ball = round.ball!;
  if (round.round_number === 0) {
    await c.query(`update public.rounds set phase = 'settled', outcome = 'opening' where id = $1`, [round.id]);
    await openRound(c, round.game_id, 1, ball);
    return false;
  }

  const alive = (
    await c.query<{ user_id: string }>(
      `select user_id from public.game_players where game_id = $1 and eliminated_round is null`,
      [round.game_id],
    )
  ).rows.map((r) => r.user_id);
  const picks: PickInput[] = (
    await c.query<{ user_id: string; direction: Direction; side_bet: bigint }>(
      `select user_id, direction, side_bet from public.picks where round_id = $1`,
      [round.id],
    )
  ).rows.map((p) => ({ userId: p.user_id, direction: p.direction, sideBet: p.side_bet }));

  const { result, eliminated } = resolveRound(alive, picks, round.prev_ball!, ball);
  const out = new Set(eliminated);
  const survivors = alive.filter((u) => !out.has(u));

  if (eliminated.length > 0) {
    await c.query(
      `update public.game_players set eliminated_round = $3, placement = $4
        where game_id = $1 and user_id = any($2::text[])`,
      [round.game_id, eliminated, round.round_number, placementFor(survivors.length)],
    );
  }

  await enqueuePayouts(
    c,
    settleSideBets(picks, result, env.HOUSE_FEE_BPS).map((p) => ({
      key: `side:${round.id}:${p.userId}`,
      userId: p.userId,
      amount: p.amount,
      reason: p.reason,
      gameId: round.game_id,
    })),
  );
  await c.query(`update public.rounds set phase = 'settled', outcome = $2 where id = $1`, [round.id, result]);

  if (isGameOver(survivors.length, round.round_number, env.MAX_ROUNDS)) {
    await finishGame(c, round, survivors, alive);
    return true;
  }
  await openRound(c, round.game_id, round.round_number + 1, ball);
  return false;
}

async function finishGame(
  c: pg.PoolClient,
  round: RoundRow,
  survivors: string[],
  lastRoundPlayers: string[],
  feeBps = env.HOUSE_FEE_BPS,
) {
  const { fee, payouts } = settlePot(round.pot, feeBps, survivors, lastRoundPlayers);
  await enqueuePayouts(
    c,
    payouts.map((p) => ({
      key: `pot:${round.game_id}:${p.userId}`,
      userId: p.userId,
      amount: p.amount,
      reason: p.reason,
      gameId: round.game_id,
    })),
  );
  if (survivors.length > 0) {
    await c.query(`update public.game_players set placement = 1 where game_id = $1 and user_id = any($2::text[])`, [
      round.game_id,
      survivors,
    ]);
  }
  await c.query(
    `update public.games set status = 'finished', fee = $2, winner_user_id = $3, ended_at = now() where id = $1`,
    [round.game_id, fee, survivors.length === 1 ? survivors[0] : null],
  );
  await c.query(`update public.lobbies set status = 'finished', updated_at = now() where id = $1`, [round.lobby_id]);
}

export interface PickRequest {
  userId: string;
  walletAddress: string | null;
  gameId: string;
  roundNumber: number;
  direction: Direction;
  sideBet: bigint;
  txHash: string | undefined;
  /** When the request reached the server; side-bet verification can take a moment. */
  arrivedAt: Date;
}

export async function placePick(req: PickRequest): Promise<void> {
  const paying = req.sideBet > 0n;
  let received = 0n;
  if (paying) {
    if (!req.txHash) throw badRequest('side bet needs a payment transaction');
    if (!req.walletAddress) throw new AppError('NO_WALLET', 'no embedded wallet linked to this account');
    received = await incomingTransferTotal({ txHash: req.txHash as Hash, from: req.walletAddress });
  }

  let rejection = null as AppError | null;
  const lobbyId = await withTx(async (c) => {
    if (paying) {
      await recordTransfer(c, {
        txHash: req.txHash!,
        userId: req.userId,
        from: req.walletAddress!,
        amount: received,
        purpose: 'side_bet',
      });
      if (received !== req.sideBet) rejection = new AppError('PAYMENT_INVALID', 'payment does not match the side bet');
      else if (req.sideBet > env.MAX_SIDE_BET_USDC) rejection = badRequest('side bet is above the table limit');
    }

    const round = (
      await c.query<RoundRow & { alive: boolean | null }>(
        `select r.*, g.lobby_id, g.pot,
                (select gp.eliminated_round is null from public.game_players gp
                  where gp.game_id = r.game_id and gp.user_id = $3) as alive
           from public.rounds r join public.games g on g.id = r.game_id
          where r.game_id = $1 and r.round_number = $2
          for update of r`,
        [req.gameId, req.roundNumber, req.userId],
      )
    ).rows[0];

    if (!rejection) {
      if (!round) rejection = notFound('round not found');
      else if (round.alive === null) rejection = badRequest('you are not playing this game');
      else if (!round.alive) rejection = badRequest('you are out — spectate till the end');
      else if (round.phase !== 'betting' || req.arrivedAt > round.phase_ends_at) rejection = conflict('calls are closed');
      else if (!isPickPossible(round.prev_ball!, req.direction)) rejection = badRequest(`nothing is ${req.direction}`);
    }

    if (!rejection && round) {
      const inserted = await c.query(
        `insert into public.picks (round_id, user_id, direction, side_bet, side_bet_tx)
         values ($1, $2, $3, $4, $5) on conflict do nothing`,
        [round.id, req.userId, req.direction, req.sideBet, paying ? req.txHash : null],
      );
      if (inserted.rowCount === 0) rejection = conflict('you already called this round');
    }

    if (rejection) {
      if (paying) {
        await enqueuePayouts(c, [
          { key: `refund:${req.txHash}`, userId: req.userId, amount: received, reason: 'refund', gameId: req.gameId },
        ]);
      }
      return round?.lobby_id ?? null;
    }

    // Everyone alive has called → close betting now; the scheduler rolls next tick.
    await c.query(
      `update public.rounds set phase_ends_at = now()
        where id = $1
          and (select count(*) from public.picks where round_id = $1) >=
              (select count(*) from public.game_players where game_id = $2 and eliminated_round is null)`,
      [round!.id, round!.game_id],
    );
    return round!.lobby_id;
  });

  if (lobbyId) lobbyChanged(lobbyId); // a call doesn't change the lobby list
  if (rejection) throw rejection;
}
