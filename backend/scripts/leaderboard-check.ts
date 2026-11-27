/**
 * Leaderboard end-to-end check: drives `leaderboard.get` through the real
 * router against a THROWAWAY Postgres. It seeds players and finished games
 * (truncating app_users and everything that references it), so it refuses any
 * database that isn't local.
 *
 *   docker run -d --name lb-db -e POSTGRES_PASSWORD=test -p 127.0.0.1:55432:5432 postgres:16-alpine
 *   DATABASE_URL=postgresql://postgres:test@127.0.0.1:55432/postgres npm run migrate:dev
 *   DATABASE_URL=postgresql://postgres:test@127.0.0.1:55432/postgres npm run check:leaderboard
 *   docker rm -f lb-db
 *
 * No network, no transactions.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

// ---- safety: never run against a real database ---------------------------
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) throw new Error('set DATABASE_URL to a throwaway Postgres');
const host = new URL(dbUrl).hostname;
if (!['localhost', '127.0.0.1', 'db', 'postgres'].includes(host)) {
  console.error(`refusing to run against ${host}: this script wipes app_users. Use a throwaway local DB.`);
  process.exit(1);
}

// ---- config (must be set before the server's config loads) ----------------
process.env.ARC_NETWORK = 'testnet';
process.env.PAYOUT_WORKER = 'false';
process.env.PRIVY_APP_ID ??= 'leaderboard-check';
process.env.TREASURY_PRIVATE_KEY = `0x${randomBytes(32).toString('hex')}`;
process.env.VRF_SUBSCRIPTION_ID ??= '1';
process.env.VRF_ROUNDS_ADDRESS ??= `0x${'11'.repeat(20)}`;
process.env.VRF_COORDINATOR_ADDRESS ??= `0x${'22'.repeat(20)}`;
process.env.LOG_LEVEL ??= 'warn';

const { WebSocket } = await import('ws');
const { pool } = await import('../src/db/pool.js');
const { route } = await import('../src/ws/router.js');
const { Session } = await import('../src/ws/hub.js');

type Reply = { type: string; reqId?: string; code?: string; data?: any };

const BUY_IN = 10_000_000n; // 10 usdc

// ---- seed ------------------------------------------------------------------
await pool.query('truncate public.app_users cascade');
const users = ['pro', 'ace', 'twinA', 'twinB', 'rookie', 'whale', 'nobody'];
for (const u of users) {
  await pool.query('insert into public.app_users (privy_user_id, wallet_address, display_name) values ($1, $2, $3)', [
    `did:${u}`,
    `0x${randomBytes(20).toString('hex')}`,
    u === 'nobody' ? null : u,
  ]);
}

/** One game; players as [user, placement]. Returns the game id. */
async function game(players: [string, number][], status: 'finished' | 'live' = 'finished'): Promise<string> {
  const lobby = await pool.query<{ id: string }>(
    `insert into public.lobbies (owner_user_id, name, buy_in, status) values ($1, 'check', $2, $3) returning id`,
    [`did:${players[0]![0]}`, BUY_IN, status],
  );
  const g = await pool.query<{ id: string }>(
    `insert into public.games (lobby_id, status, pot, ended_at) values ($1, $2, $3, $4) returning id`,
    [lobby.rows[0]!.id, status, BUY_IN * BigInt(players.length), status === 'finished' ? new Date() : null],
  );
  const gameId = g.rows[0]!.id;
  for (const [u, placement] of players) {
    await pool.query(
      `insert into public.game_players (game_id, user_id, display_name, buy_in, placement) values ($1, $2, $3, $4, $5)`,
      [gameId, `did:${u}`, u, BUY_IN, placement],
    );
  }
  return gameId;
}
const solo = async (u: string, wins: number, losses: number) => {
  for (let i = 0; i < wins; i++) await game([[u, 1]]);
  for (let i = 0; i < losses; i++) await game([[u, 2]]);
};

await solo('pro', 6, 2); // 75%, 6 wins
await solo('ace', 2, 1); // + the game below = 3/4 = 75%, fewer wins than pro
const aceWin = await game([
  ['ace', 1],
  ['rookie', 2],
]);
// ace: 50 usdc pot paid, a failed payout (ignored) and a 5 usdc side bet.
await pool.query(
  `insert into public.payouts (idempotency_key, user_id, to_address, amount, reason, game_id, status)
   values ('k1', 'did:ace', '0x0', 50000000, 'pot', $1, 'confirmed'),
          ('k2', 'did:ace', '0x0', 99000000, 'pot', $1, 'failed')`,
  [aceWin],
);
const round = await pool.query<{ id: string }>(
  `insert into public.rounds (game_id, round_number, phase, phase_ends_at) values ($1, 1, 'settled', now()) returning id`,
  [aceWin],
);
await pool.query(`insert into public.picks (round_id, user_id, direction, side_bet) values ($1, 'did:ace', 'higher', 5000000)`, [
  round.rows[0]!.id,
]);
await game([['ace', 1]], 'live'); // live games never count

await game([
  ['twinA', 1],
  ['twinB', 1],
]); // split: a win for both
await solo('twinA', 0, 2); // 1/3
await solo('twinB', 0, 2); // 1/3, same everything as twinA
await solo('rookie', 1, 0); // 2 games (incl. ace's), below the minimum
// whale and nobody: no games at all

// ---- helpers -----------------------------------------------------------------
function session(userId: string | null) {
  const sent: Reply[] = [];
  const socket = { readyState: WebSocket.OPEN, bufferedAmount: 0, send: (d: string) => sent.push(JSON.parse(d)) };
  const s = new Session(socket as unknown as InstanceType<typeof WebSocket>);
  s.userId = userId;
  return { s, sent };
}

async function ask(userId: string | null, reqId = 'r1'): Promise<Reply> {
  const { s, sent } = session(userId);
  await route(s, JSON.stringify({ type: 'leaderboard.get', reqId }));
  assert.equal(sent.length, 1, 'exactly one reply');
  return sent[0]!;
}

// 1. Not signed in → rejected.
const anon = await ask(null);
assert.equal(anon.type, 'error');
assert.equal(anon.code, 'UNAUTHENTICATED');
console.log('✓ unauthenticated request rejected');

// 2. Ranking by win rate, then wins; ties share a rank.
const top = await ask('did:ace');
assert.equal(top.type, 'ack', JSON.stringify(top));
const v = top.data;
assert.deepEqual(
  v.entries.map((e: any) => [e.name, e.rank, e.wins, e.games]),
  [
    ['pro', 1, 6, 8],
    ['ace', 2, 3, 4],
    ['twinA', 3, 1, 3],
    ['twinB', 3, 1, 3],
  ],
);
assert.equal(v.total, 4);
assert.equal(v.minGames, 3);
console.log('✓ ranked by win rate, more wins breaks a tie, equal stats share a rank');

// 3. Net = confirmed payouts − buy-ins − side bets; live game and failed payout ignored.
const ace = v.entries[1];
assert.equal(ace.isMe, true);
assert.equal(ace.net, String(50_000_000n - 4n * BUY_IN - 5_000_000n));
assert.equal(v.entries[0].net, String(-8n * BUY_IN));
assert.equal(v.me, null, 'viewer already in entries');
console.log('✓ net profit correct, live games and failed payouts ignored');

// 4. Wallet balance plays no part; unplayed users are absent.
assert.ok(!v.entries.some((e: any) => e.name === 'whale' || e.name === 'rookie'));
console.log('✓ players without enough finished games are not ranked');

// 5. Unranked viewer gets their own row with rank null.
const rookie = (await ask('did:rookie')).data;
assert.deepEqual(
  [rookie.me.name, rookie.me.rank, rookie.me.games, rookie.me.wins, rookie.me.isMe],
  ['rookie', null, 2, 1, true],
);
console.log('✓ unranked viewer sees their progress row');

// 6. Viewer with no games → board, no own row.
const whale = (await ask('did:whale')).data;
assert.equal(whale.me, null);
assert.equal(whale.entries.length, 4);
assert.ok(whale.entries.every((e: any) => !e.isMe));
console.log('✓ viewer with no games still sees the board');

// 7. Malformed requests → BAD_REQUEST, not a crash.
{
  const { s, sent } = session('did:ace');
  await route(s, '{not json');
  await route(s, JSON.stringify({ type: 'leaderboard.get', reqId: 'x'.repeat(65) }));
  assert.equal(sent[0]?.code, 'BAD_REQUEST');
  assert.equal(sent[1]?.code, 'BAD_REQUEST');
  console.log('✓ malformed requests → BAD_REQUEST');
}

await pool.query('truncate public.app_users cascade');
await pool.end();
console.log('\nall leaderboard checks passed');
