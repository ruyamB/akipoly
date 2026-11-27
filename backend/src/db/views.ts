/**
 * Read models pushed to clients. One load per change per lobby, then the
 * private `me` part is attached per socket from the same data.
 */
import { getAddress } from 'viem';
import { arc, env } from '../config/env.js';
import type { Db } from './pool.js';
import type { RoundVrf, VrfContracts } from '../shared/protocol.js';

const VRF_COLUMNS =
  'vrf_request_id, vrf_request_tx, vrf_request_block, vrf_fulfill_tx, vrf_random_word, vrf_rounds_address, vrf_coordinator';
interface VrfColumns {
  vrf_request_id: string | null;
  vrf_request_tx: string | null;
  vrf_request_block: bigint | null;
  vrf_fulfill_tx: string | null;
  vrf_random_word: string | null;
  vrf_rounds_address: string | null;
  vrf_coordinator: string | null;
}

function vrfOf(r: VrfColumns): RoundVrf | null {
  if (!r.vrf_request_id || !r.vrf_request_tx || r.vrf_request_block === null || !r.vrf_random_word) return null;
  return {
    requestId: r.vrf_request_id,
    requestTx: r.vrf_request_tx,
    requestBlock: r.vrf_request_block.toString(),
    fulfillTx: r.vrf_fulfill_tx,
    randomWord: r.vrf_random_word,
    rounds: r.vrf_rounds_address,
    coordinator: r.vrf_coordinator,
  };
}

export function vrfContracts(): VrfContracts {
  return {
    rounds: getAddress(env.VRF_ROUNDS_ADDRESS),
    coordinator: getAddress(arc.vrf.coordinator),
    vrfExplorer: arc.vrf.explorerUrl,
  };
}
import type {
  CareerEntry,
  Direction,
  GameReview,
  LedgerEntry,
  PayoutReason,
  PayoutStatus,
  ReviewRound,
  GamePlayerView,
  GameView,
  LobbySummary,
  LobbyView,
  RoundHistoryEntry,
  RoundOutcome,
  RoundPhase,
  RoundView,
} from '../shared/protocol.js';

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export async function upsertUser(db: Db, userId: string, walletAddress: string | null): Promise<void> {
  await db.query(
    `insert into public.app_users (privy_user_id, wallet_address)
     values ($1, $2)
     on conflict (privy_user_id) do update
       set wallet_address = coalesce(excluded.wallet_address, public.app_users.wallet_address),
           updated_at = now()`,
    [userId, walletAddress],
  );
}

export async function listLobbies(db: Db): Promise<LobbySummary[]> {
  const res = await db.query<{
    id: string;
    name: string;
    buy_in: bigint;
    max_players: number;
    status: LobbySummary['status'];
    created_at: Date;
    player_ids: string[];
  }>(
    `select l.id, l.name, l.buy_in, l.max_players, l.status, l.created_at,
            coalesce(array_agg(p.user_id order by p.joined_at) filter (where p.user_id is not null), '{}') as player_ids
       from public.lobbies l
       left join public.lobby_players p on p.lobby_id = l.id
      where l.status in ('waiting', 'starting', 'live')
      group by l.id
      order by l.created_at desc
      limit 50`,
  );
  return res.rows.map((r) => ({
    id: r.id,
    name: r.name,
    buyIn: r.buy_in.toString(),
    maxPlayers: r.max_players,
    status: r.status,
    playerIds: r.player_ids,
    createdAt: r.created_at.toISOString(),
  }));
}

export async function lobbyView(db: Db, lobbyId: string): Promise<LobbyView | null> {
  const lobby = await db.query<{
    id: string;
    name: string;
    owner_user_id: string;
    buy_in: bigint;
    max_players: number;
    status: LobbyView['status'];
    starts_at: Date | null;
    game_id: string | null;
  }>(
    `select l.id, l.name, l.owner_user_id, l.buy_in, l.max_players, l.status, l.starts_at, g.id as game_id
       from public.lobbies l left join public.games g on g.lobby_id = l.id
      where l.id = $1`,
    [lobbyId],
  );
  const l = lobby.rows[0];
  if (!l) return null;
  const players = await db.query<{ user_id: string; display_name: string; ready: boolean }>(
    `select user_id, display_name, ready from public.lobby_players where lobby_id = $1 order by joined_at`,
    [lobbyId],
  );
  return {
    id: l.id,
    name: l.name,
    ownerUserId: l.owner_user_id,
    buyIn: l.buy_in.toString(),
    maxPlayers: l.max_players,
    status: l.status,
    startsAt: iso(l.starts_at),
    gameId: l.game_id,
    players: players.rows.map((p) => ({ userId: p.user_id, displayName: p.display_name, ready: p.ready })),
  };
}

export interface LoadedGame {
  view: Omit<GameView, 'me'>;
  picks: Map<string, { direction: Direction; sideBet: string }>;
}

export async function loadGame(db: Db, gameId: string): Promise<LoadedGame | null> {
  const g = (
    await db.query<{
      id: string;
      lobby_id: string;
      status: 'live' | 'finished';
      pot: bigint;
      fee: bigint;
      winner_user_id: string | null;
    }>(`select id, lobby_id, status, pot, fee, winner_user_id from public.games where id = $1`, [gameId])
  ).rows[0];
  if (!g) return null;

  const [playersRes, roundsRes] = await Promise.all([
    db.query<{ user_id: string; display_name: string; eliminated_round: number | null; placement: number | null }>(
      `select user_id, display_name, eliminated_round, placement
         from public.game_players where game_id = $1 order by display_name`,
      [gameId],
    ),
    db.query<{
      id: string;
      round_number: number;
      phase: RoundPhase;
      prev_ball: number | null;
      ball: number | null;
      outcome: RoundOutcome | null;
      phase_ends_at: Date;
    } & VrfColumns>(
      `select id, round_number, phase, prev_ball, ball, outcome, phase_ends_at, ${VRF_COLUMNS}
         from public.rounds where game_id = $1 order by round_number desc limit 11`,
      [gameId],
    ),
  ]);

  const current = roundsRes.rows[0];
  const picks = new Map<string, { direction: Direction; sideBet: string }>();
  let round: RoundView | null = null;
  if (current) {
    const picksRes = await db.query<{ user_id: string; direction: Direction; side_bet: bigint }>(
      `select user_id, direction, side_bet from public.picks where round_id = $1`,
      [current.id],
    );
    const pools = { higher: 0n, lower: 0n };
    for (const p of picksRes.rows) {
      picks.set(p.user_id, { direction: p.direction, sideBet: p.side_bet.toString() });
      pools[p.direction] += p.side_bet;
    }
    round = {
      number: current.round_number,
      phase: current.phase,
      prevBall: current.prev_ball,
      // Unknown to everyone until the VRF answers; set together with the move to rolling.
      ball: current.phase === 'betting' || current.phase === 'drawing' ? null : current.ball,
      vrf: vrfOf(current),
      phaseEndsAt: current.phase_ends_at.toISOString(),
      picksIn: picksRes.rows.length,
      sidePools: { higher: pools.higher.toString(), lower: pools.lower.toString() },
    };
  }

  const players: GamePlayerView[] = playersRes.rows.map((p) => ({
    userId: p.user_id,
    displayName: p.display_name,
    alive: p.eliminated_round === null,
    eliminatedRound: p.eliminated_round,
    placement: p.placement,
    picked: picks.has(p.user_id),
  }));

  const history: RoundHistoryEntry[] = roundsRes.rows
    .filter((r) => r.phase === 'settled' && r.ball !== null && r.outcome)
    .map((r) => ({ number: r.round_number, prevBall: r.prev_ball, ball: r.ball!, outcome: r.outcome! }));

  return {
    view: {
      id: g.id,
      lobbyId: g.lobby_id,
      status: g.status,
      pot: g.pot.toString(),
      fee: g.fee.toString(),
      winnerUserId: g.winner_user_id,
      round,
      players,
      history,
    },
    picks,
  };
}

export function gameViewFor(loaded: LoadedGame, userId: string | null): GameView {
  const player = userId ? loaded.view.players.find((p) => p.userId === userId) : undefined;
  return {
    ...loaded.view,
    me: player ? { alive: player.alive, pick: loaded.picks.get(player.userId) ?? null } : null,
  };
}

export async function careerFor(db: Db, userId: string): Promise<CareerEntry[]> {
  const res = await db.query<{
    game_id: string;
    lobby_id: string;
    status: 'live' | 'finished';
    lobby_name: string;
    started_at: Date;
    ended_at: Date | null;
    placement: number | null;
    eliminated_round: number | null;
    buy_in: bigint;
    paid_in: string;
    won: string;
  }>(
    `select g.id as game_id, l.id as lobby_id, g.status, l.name as lobby_name, g.started_at, g.ended_at,
            gp.placement, gp.eliminated_round, gp.buy_in,
            (gp.buy_in + coalesce((select sum(pk.side_bet) from public.picks pk
                                     join public.rounds r on r.id = pk.round_id
                                    where r.game_id = g.id and pk.user_id = gp.user_id), 0))::text as paid_in,
            coalesce((select sum(p.amount) from public.payouts p
                       where p.game_id = g.id and p.user_id = gp.user_id and p.status <> 'failed'
                         and p.reason in ('pot', 'split', 'side_win', 'side_refund')), 0)::text as won
       from public.game_players gp
       join public.games g on g.id = gp.game_id
       join public.lobbies l on l.id = g.lobby_id
      where gp.user_id = $1
      order by g.started_at desc
      limit 20`,
    [userId],
  );
  return res.rows.map((r) => ({
    gameId: r.game_id,
    lobbyId: r.lobby_id,
    status: r.status,
    lobbyName: r.lobby_name,
    startedAt: r.started_at.toISOString(),
    endedAt: iso(r.ended_at),
    placement: r.placement,
    eliminatedRound: r.eliminated_round,
    buyIn: r.buy_in.toString(),
    paidIn: r.paid_in,
    won: r.won,
  }));
}

/**
 * Full post-game breakdown for one participant: settled rounds (with their
 * on-chain VRF draws and everyone's calls), standings, and the viewer's own USDC ledger.
 * Returns null if the viewer didn't play this game.
 */
export async function gameReview(db: Db, gameId: string, userId: string, treasury: string): Promise<GameReview | null> {
  const head = (
    await db.query<{
      id: string;
      lobby_id: string;
      lobby_name: string;
      buy_in: bigint;
      status: 'live' | 'finished';
      started_at: Date;
      ended_at: Date | null;
      pot: bigint;
      fee: bigint;
      winner_user_id: string | null;
    }>(
      `select g.id, g.lobby_id, l.name as lobby_name, l.buy_in, g.status, g.started_at, g.ended_at,
              g.pot, g.fee, g.winner_user_id
         from public.games g join public.lobbies l on l.id = g.lobby_id
        where g.id = $1`,
      [gameId],
    )
  ).rows[0];
  if (!head) return null;

  const players = (
    await db.query<{
      user_id: string;
      display_name: string;
      placement: number | null;
      eliminated_round: number | null;
    }>(
      `select user_id, display_name, placement, eliminated_round from public.game_players
        where game_id = $1 order by placement nulls first, eliminated_round desc nulls first, display_name`,
      [gameId],
    )
  ).rows;
  const me = players.find((p) => p.user_id === userId);
  if (!me) return null;

  // Sequential on purpose: one review holds at most one pool connection, so
  // players browsing history can't starve settlements and the scheduler.
  const roundsRes = await db.query<{
    id: string;
    round_number: number;
    prev_ball: number | null;
    ball: number;
    outcome: RoundOutcome;
    legacy_seed: string | null;
    legacy_seed_hash: string | null;
  } & VrfColumns>(
    `select r.id, r.round_number, r.prev_ball, r.ball, r.outcome, ${VRF_COLUMNS},
            l.seed as legacy_seed, l.seed_hash as legacy_seed_hash
       from public.rounds r left join public.legacy_round_seeds l on l.round_id = r.id
      where r.game_id = $1 and r.phase = 'settled' and r.ball is not null -- undrawn void rounds have no ball
      order by r.round_number`,
    [gameId],
  );
  const picksRes = await db.query<{ round_id: string; user_id: string; direction: Direction; side_bet: bigint }>(
    `select p.round_id, p.user_id, p.direction, p.side_bet
         from public.picks p join public.rounds r on r.id = p.round_id
        where r.game_id = $1 and r.phase = 'settled'
        order by p.created_at`,
    [gameId],
  );
  const sideRes = await db.query<{
    round_id: string;
    user_id: string;
    amount: bigint;
    reason: 'side_win' | 'side_refund';
  }>(
    `select split_part(idempotency_key, ':', 2) as round_id, user_id, amount, reason
         from public.payouts where game_id = $1 and reason in ('side_win', 'side_refund')`,
    [gameId],
  );
  // Money in: the buy-in, side bets placed in this game, and side-bet
  // payments that were refunded (their refund payout carries the tx hash).
  const insRes = await db.query<{
    tx_hash: string;
    amount: bigint;
    purpose: 'buy_in' | 'side_bet';
    created_at: Date;
    round_number: number | null;
  }>(
    `select t.tx_hash, t.amount, t.purpose, t.created_at, r.round_number
         from public.chain_transfers t
         left join public.picks p on p.side_bet_tx = t.tx_hash
         left join public.rounds r on r.id = p.round_id
        where t.user_id = $2
          and (t.tx_hash = (select buy_in_tx from public.lobby_players where lobby_id = $3 and user_id = $2)
               or r.game_id = $1
               or t.tx_hash in (select substr(idempotency_key, 8) from public.payouts
                                 where game_id = $1 and user_id = $2 and idempotency_key like 'refund:%'))`,
    [gameId, userId, head.lobby_id],
  );
  const outsRes = await db.query<{
    amount: bigint;
    reason: PayoutReason;
    status: PayoutStatus;
    tx_hash: string | null;
    created_at: Date;
    round_number: number | null;
  }>(
    `select o.amount, o.reason, o.status, o.tx_hash, o.created_at, r.round_number
         from public.payouts o
         left join public.rounds r
           on o.reason in ('side_win', 'side_refund') and r.id::text = split_part(o.idempotency_key, ':', 2)
        where o.game_id = $1 and o.user_id = $2`,
    [gameId, userId],
  );

  const rounds: ReviewRound[] = roundsRes.rows.map((r) => ({
    number: r.round_number,
    prevBall: r.prev_ball,
    ball: r.ball,
    outcome: r.outcome,
    vrf: vrfOf(r),
    legacy: r.legacy_seed && r.legacy_seed_hash ? { seed: r.legacy_seed, seedHash: r.legacy_seed_hash } : null,
    picks: picksRes.rows
      .filter((p) => p.round_id === r.id)
      .map((p) => ({ userId: p.user_id, direction: p.direction, sideBet: p.side_bet.toString() })),
    eliminated: players.filter((p) => p.eliminated_round === r.round_number).map((p) => p.user_id),
    sideResults: sideRes.rows
      .filter((x) => x.round_id === r.id)
      .map((x) => ({ userId: x.user_id, amount: x.amount.toString(), reason: x.reason })),
  }));

  const ledger: LedgerEntry[] = [
    ...insRes.rows.map((t) => ({
      flow: 'in' as const,
      kind: t.purpose,
      amount: t.amount.toString(),
      txHash: t.tx_hash,
      status: 'confirmed' as const,
      roundNumber: t.round_number,
      at: t.created_at.toISOString(),
    })),
    ...outsRes.rows.map((o) => ({
      flow: 'out' as const,
      kind: o.reason,
      amount: o.amount.toString(),
      txHash: o.tx_hash,
      status: o.status,
      roundNumber: o.round_number,
      at: o.created_at.toISOString(),
    })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  return {
    gameId: head.id,
    lobbyId: head.lobby_id,
    lobbyName: head.lobby_name,
    status: head.status,
    startedAt: head.started_at.toISOString(),
    endedAt: iso(head.ended_at),
    buyIn: head.buy_in.toString(),
    pot: head.pot.toString(),
    fee: head.fee.toString(),
    winnerUserId: head.winner_user_id,
    treasury,
    vrfContracts: vrfContracts(),
    players: players.map((p) => ({
      userId: p.user_id,
      displayName: p.display_name,
      placement: p.placement,
      eliminatedRound: p.eliminated_round,
    })),
    rounds,
    ledger,
    me: { userId, placement: me.placement, eliminatedRound: me.eliminated_round },
  };
}
