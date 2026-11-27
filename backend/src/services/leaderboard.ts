/**
 * Leaderboard: players ranked by skill, read from finished games only.
 * Rank = win rate (wins ÷ finished games), then more wins, then net profit.
 * Wallet balance plays no part: holding USDC isn't skill.
 */
import { pool } from '../db/pool.js';
import type { LeaderboardEntry, LeaderboardView } from '../shared/protocol.js';

/** Finished games needed before a player is ranked; fewer is just luck. */
export const MIN_GAMES = 3;
const TOP = 100;

interface Row {
  user_id: string;
  name: string | null;
  wallet_address: string | null;
  games: number;
  wins: number;
  net: string;
  rank: string | null;
}

// ponytail: aggregates every finished game per request; add a short cache or a
// stats table if this query shows up as slow.
const QUERY = `
  with played as (
    select gp.user_id, count(*)::int as games,
           count(*) filter (where gp.placement = 1)::int as wins,
           sum(gp.buy_in) as buy_ins
      from public.game_players gp
      join public.games g on g.id = gp.game_id and g.status = 'finished'
     group by gp.user_id
  ), side as (
    select pk.user_id, sum(pk.side_bet) as side_bets
      from public.picks pk
      join public.rounds r on r.id = pk.round_id
      join public.games g on g.id = r.game_id and g.status = 'finished'
     group by pk.user_id
  ), paid as (
    select p.user_id, sum(p.amount) as won
      from public.payouts p
      join public.games g on g.id = p.game_id and g.status = 'finished'
     where p.status <> 'failed' and p.reason in ('pot', 'split', 'side_win', 'side_refund')
     group by p.user_id
  ), stats as (
    select pl.user_id, u.display_name as name, u.wallet_address, pl.games, pl.wins,
           coalesce(pd.won, 0) - pl.buy_ins - coalesce(s.side_bets, 0) as net
      from played pl
      join public.app_users u on u.privy_user_id = pl.user_id
      left join side s on s.user_id = pl.user_id
      left join paid pd on pd.user_id = pl.user_id
  ), ranked as (
    select user_id, rank() over (order by wins::numeric / games desc, wins desc, net desc) as rank
      from stats where games >= $1
  )
  select st.user_id, st.name, st.wallet_address, st.games, st.wins, st.net::text as net, rk.rank::text as rank
    from stats st
    left join ranked rk on rk.user_id = st.user_id
   where rk.rank is not null or st.user_id = $2
   order by rk.rank nulls last, st.user_id`;

export async function leaderboardFor(viewerUserId: string): Promise<LeaderboardView> {
  const { rows } = await pool.query<Row>(QUERY, [MIN_GAMES, viewerUserId]);
  const view = (r: Row): LeaderboardEntry => ({
    rank: r.rank === null ? null : Number(r.rank),
    name: r.name,
    walletAddress: r.wallet_address,
    games: r.games,
    wins: r.wins,
    net: r.net,
    isMe: r.user_id === viewerUserId,
  });

  const ranked = rows.filter((r) => r.rank !== null);
  const entries = ranked.slice(0, TOP).map(view);
  const mine = rows.find((r) => r.user_id === viewerUserId);
  return {
    entries,
    me: mine && !entries.some((e) => e.isMe) ? view(mine) : null,
    total: ranked.length,
    minGames: MIN_GAMES,
  };
}
