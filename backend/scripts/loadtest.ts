/**
 * Load test: N tables × M players play full games through the real services,
 * scheduler and push hub against a THROWAWAY Postgres. Players are fake
 * sockets that react to pushed game views like the web client does (call
 * higher/lower a moment after a round opens). No chain calls: buy-ins are
 * marked paid in SQL, calls carry no side bet, and VRF draws are answered by
 * an in-process stand-in after LOADTEST_VRF_MS (1500).
 *
 *   docker compose -f docker-compose.loadtest.yml run --rm loadtest
 *   # or, against any local Postgres:
 *   DATABASE_URL=postgresql://postgres:test@localhost:5432/postgres npm run loadtest
 *
 * Knobs: LOADTEST_TABLES (10), LOADTEST_PLAYERS (10), LOADTEST_P95_MS (250), LOADTEST_VRF_MS (1500).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

// ---- safety: never run against a real database ---------------------------
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) throw new Error('set DATABASE_URL to a throwaway Postgres');
const host = new URL(dbUrl).hostname;
if (!['localhost', '127.0.0.1', 'db', 'postgres'].includes(host) && process.env.LOADTEST_ALLOW !== '1') {
  console.error(`refusing to load-test ${host}; use a throwaway DB or set LOADTEST_ALLOW=1`);
  process.exit(1);
}

// ---- fast game timing (must be set before config loads) -------------------
process.env.BETTING_SECONDS ??= '5';
process.env.ROLLING_MS ??= '1000';
process.env.START_COUNTDOWN_MS ??= '0';
process.env.MAX_ROUNDS ??= '15';
process.env.PRIVY_APP_ID ??= 'loadtest';
process.env.TREASURY_PRIVATE_KEY ??= `0x${randomBytes(32).toString('hex')}`;
process.env.LOG_LEVEL ??= 'warn';
// No chain here: VRF draws are answered by the stand-in below.
process.env.VRF_ROUNDS_ADDRESS ??= `0x${'11'.repeat(20)}`;
process.env.VRF_SUBSCRIPTION_ID ??= '1';
/** Simulated request + proof round trip on Arc. */
const VRF_LATENCY_MS = Number(process.env.LOADTEST_VRF_MS ?? 1500);

const TABLES = Number(process.env.LOADTEST_TABLES ?? 10);
const PLAYERS = Number(process.env.LOADTEST_PLAYERS ?? 10);
const P95_LIMIT_MS = Number(process.env.LOADTEST_P95_MS ?? 250);
const DEADLINE_MS = 5 * 60_000;

const { migrate } = await import('../src/db/migrate.js');
const { pool, poolStats } = await import('../src/db/pool.js');
const { upsertUser } = await import('../src/db/views.js');
const { createLobby, joinLobby } = await import('../src/services/lobby.js');
const { placePick } = await import('../src/services/game.js');
const { startScheduler, stopScheduler } = await import('../src/scheduler/ticker.js');
const { Session, bindUser, watchList, watchLobby } = await import('../src/ws/hub.js');
const { events, lobbiesChanged } = await import('../src/events.js');
type GameView = import('../src/shared/protocol.js').GameView;

// ---- metrics ---------------------------------------------------------------
const pickMs: number[] = [];
const pushMs: number[] = [];
const phaseLateMs: number[] = [];
let pickErrors = 0;
let messages = 0;
let bytes = 0;
let maxPoolWaiting = 0;
const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};
const fmt = (xs: number[]) =>
  `n=${xs.length} p50=${pct(xs, 50).toFixed(1)} p95=${pct(xs, 95).toFixed(1)} max=${pct(xs, 100).toFixed(1)} ms`;

// ---- VRF stand-in ------------------------------------------------------------
// The treasury worker isn't started (it would need Arc). Instead, queued draws
// are answered in SQL after VRF_LATENCY_MS with a random ball, moving the round
// drawing → rolling exactly like services/vrf.ts finish() does. This tests the
// server and database, not the chain.
async function answerVrfDraws(): Promise<void> {
  const { rows } = await pool.query<{ lobby_id: string }>(
    `with due as (
       update public.vrf_jobs set status = 'done', updated_at = now()
        where status = 'pending' returning round_id
     )
     update public.rounds r
        set phase = 'rolling', ball = floor(random() * 17)::int, phase_ends_at = now() + $1::interval
       from due, public.games g
      where r.id = due.round_id and r.phase = 'drawing' and g.id = r.game_id
      returning g.lobby_id`,
    [`${process.env.ROLLING_MS} milliseconds`],
  );
  for (const { lobby_id } of rows) events.emit('lobby', lobby_id);
}
events.on('vrf', () => {
  setTimeout(() => void answerVrfDraws().catch((err) => console.error('VRF stand-in failed', err)), VRF_LATENCY_MS);
});

// change → first push received, per lobby
const changedAt = new Map<string, number>();
events.on('lobby', (id) => {
  if (!changedAt.has(id)) changedAt.set(id, performance.now());
});

// ---- fake clients ------------------------------------------------------------
const finished = new Set<string>();
const gameIds = new Set<string>();

class FakeSocket {
  readyState = 1; // WebSocket.OPEN
  bufferedAmount = 0;
  session!: InstanceType<typeof Session>;
  private lastRound = -1;
  private lastPhase = '';
  private lastEndsAt = 0;

  send(data: string) {
    messages += 1;
    bytes += data.length;
    if (!data.startsWith('{"type":"game"')) return;
    const lobbyId = this.session.lobbyId!;
    const t0 = changedAt.get(lobbyId);
    if (t0 !== undefined) {
      pushMs.push(performance.now() - t0);
      changedAt.delete(lobbyId);
    }
    const { game, serverNow } = JSON.parse(data) as { game: GameView; serverNow: number };
    this.react(game, serverNow);
  }

  private react(game: GameView, serverNow: number) {
    gameIds.add(game.id);
    if (game.status === 'finished') finished.add(game.id);
    const r = game.round;
    if (!r) return;
    const phaseKey = `${r.number}:${r.phase}`;
    if (phaseKey !== `${this.lastRound}:${this.lastPhase}`) {
      // Scheduler lateness: how long after the previous deadline this phase showed up.
      if (this.lastEndsAt && this.session.userId?.endsWith(':0')) {
        const late = serverNow - this.lastEndsAt;
        if (late >= 0) phaseLateMs.push(late);
      }
      this.lastRound = r.number;
      this.lastPhase = r.phase;
      this.lastEndsAt = new Date(r.phaseEndsAt).getTime();
      if (r.phase === 'betting' && game.me?.alive && !game.me.pick) this.call(game.id, r.number, r.prevBall ?? 8);
    }
  }

  private call(gameId: string, roundNumber: number, prev: number) {
    const options = (['higher', 'lower'] as const).filter((d) => (d === 'higher' ? prev < 16 : prev > 0));
    const direction = options[Math.floor(Math.random() * options.length)]!;
    const thinkMs = 300 + Math.random() * 2500; // humans don't all click at once
    setTimeout(async () => {
      const t = performance.now();
      try {
        await placePick({
          userId: this.session.userId!,
          walletAddress: null,
          gameId,
          roundNumber,
          direction,
          sideBet: 0n,
          txHash: undefined,
          arrivedAt: new Date(),
        });
        pickMs.push(performance.now() - t);
      } catch {
        pickErrors += 1;
      }
    }, thinkMs);
  }

  close() {}
  terminate() {}
}

// ---- run ---------------------------------------------------------------------
console.log(`load test: ${TABLES} tables × ${PLAYERS} players = ${TABLES * PLAYERS} concurrent players`);
await migrate();
const run = randomUUID().slice(0, 8);
const sampler = setInterval(() => {
  maxPoolWaiting = Math.max(maxPoolWaiting, poolStats().waiting);
}, 25);

const lobbyIds: string[] = [];
const started = performance.now();
await Promise.all(
  Array.from({ length: TABLES }, async (_, t) => {
    const ids = Array.from({ length: PLAYERS }, (_, p) => `lt-${run}-${t}:${p}`);
    for (const [i, id] of ids.entries()) await upsertUser(pool, id, `0x${(t * 100 + i + 1).toString(16).padStart(40, '0')}`);
    const lobbyId = await createLobby(ids[0]!, `load ${t}`, 'p0', 1_000_000n);
    for (const [i, id] of ids.slice(1).entries()) await joinLobby(id, lobbyId, `p${i + 1}`);
    lobbyIds.push(lobbyId);
    for (const id of ids) {
      const socket = new FakeSocket();
      const session = new Session(socket as never);
      socket.session = session;
      session.userId = id;
      bindUser(session);
      await watchList(session);
      await watchLobby(session, lobbyId);
    }
  }),
);
console.log(`seated ${TABLES * PLAYERS} players in ${((performance.now() - started) / 1000).toFixed(1)}s`);

// Everyone pays (in SQL — no chain in a load test) and the countdown starts.
await pool.query(
  `update public.lobby_players set ready = true, buy_in_tx = 'lt-' || lobby_id || '-' || user_id
    where lobby_id = any($1::uuid[])`,
  [lobbyIds],
);
await pool.query(
  `update public.lobbies set status = 'starting', starts_at = now() where id = any($1::uuid[])`,
  [lobbyIds],
);
startScheduler();
lobbiesChanged(lobbyIds);

const gameStart = performance.now();
while (performance.now() - gameStart < DEADLINE_MS) {
  if (gameIds.size === TABLES && finished.size === TABLES) break;
  await new Promise((r) => setTimeout(r, 250));
}
const elapsed = (performance.now() - gameStart) / 1000;
stopScheduler();
clearInterval(sampler);

const rounds = (
  await pool.query<{ n: bigint }>(
    `select count(*) as n from public.rounds r join public.games g on g.id = r.game_id
      where g.lobby_id = any($1::uuid[]) and r.phase = 'settled'`,
    [lobbyIds],
  )
).rows[0]!.n;

console.log(`
games finished    ${finished.size}/${TABLES} in ${elapsed.toFixed(1)}s (${rounds} rounds settled)
placePick         ${fmt(pickMs)}  (${pickErrors} rejected)
change → push     ${fmt(pushMs)}
phase lateness    ${fmt(phaseLateMs)}
pool              max waiting ${maxPoolWaiting} (pool max ${process.env.DB_POOL_MAX ?? 10})
pushed            ${messages} messages, ${(bytes / 1024 / 1024).toFixed(2)} MB
`);
await pool.end();

const ok = finished.size === TABLES && pct(pickMs, 95) <= P95_LIMIT_MS;
console.log(ok ? 'LOAD TEST PASSED' : 'LOAD TEST FAILED');
process.exit(ok ? 0 : 1);
