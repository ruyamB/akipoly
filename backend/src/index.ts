import { createServer } from 'node:http';
import { arc, env } from './config/env.js';
import { log } from './log.js';
import { pool, poolStats } from './db/pool.js';
import { pendingMigrations } from './db/migrate.js';
import { treasuryAddress } from './chain/usdc.js';
import { startScheduler, stopScheduler } from './scheduler/ticker.js';
import { startTreasuryWorker, stopTreasuryWorker } from './services/treasuryWorker.js';
import { checkVrfSetup, roundsAddress } from './chain/vrf.js';
import { attachWebSocket } from './ws/server.js';

async function main() {
  const pending = await pendingMigrations().catch((err) => {
    log.fatal({ err }, 'cannot reach the database — check DATABASE_URL and network');
    process.exit(1);
  });
  if (pending.length) {
    log.fatal({ pending }, 'database schema is behind — run `npm run migrate` first');
    process.exit(1);
  }

  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/health') {
      // Held VRF draws need an operator (see vrf_jobs.last_error).
      const vrfHeld = await pool
        .query<{ n: bigint }>(`select count(*) as n from public.vrf_jobs where status = 'held'`)
        .then((r) => Number(r.rows[0]!.n))
        .catch(() => null);
      return send(200, { status: 'ok', network: arc.network, db: poolStats(), vrfHeld });
    }
    if (req.url === '/ready') {
      try {
        await pool.query('select 1');
        return send(200, { status: 'ready' });
      } catch {
        return send(503, { status: 'db unavailable' });
      }
    }
    send(404, { error: 'not found' });
  });

  const wss = attachWebSocket(server);
  startScheduler();
  if (env.PAYOUT_WORKER) void startTreasuryWhenWired();

  server.listen(env.PORT, () => {
    log.info({ port: env.PORT, network: arc.network, chainId: arc.chainId, treasury: treasuryAddress, vrfRounds: roundsAddress }, 'akipoly game server up');
  });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'shutting down');
    stopScheduler();
    stopTreasuryWorker();
    for (const client of wss.clients) client.close(1001, 'server restarting');
    wss.close();
    server.close();
    await pool.end().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => log.error({ err }, 'unhandled rejection'));
}

/**
 * Start the treasury worker once the VRF contracts are confirmed wired to this
 * treasury. A real mismatch is fatal (every round would stall in drawing); an
 * unreachable RPC is retried in the background so lobbies and sockets still come up.
 */
async function startTreasuryWhenWired(): Promise<void> {
  for (let wait = 2_000; ; wait = Math.min(wait * 2, 60_000)) {
    const check = await checkVrfSetup();
    if (check.mismatches.length) {
      log.fatal({ problems: check.mismatches }, 'VRF contracts are not wired to this treasury — every round would stall in drawing');
      process.exit(1);
    }
    if (!check.unreachable) {
      for (const warning of check.warnings) log.warn({ warning }, 'Arc VRF subscription needs attention');
      startTreasuryWorker();
      return;
    }
    log.warn({ err: check.unreachable, retryInMs: wait }, 'cannot reach Arc to check the VRF contracts, retrying');
    await new Promise((r) => setTimeout(r, wait));
  }
}

main().catch((err) => {
  log.fatal({ err }, 'failed to start');
  process.exit(1);
});
