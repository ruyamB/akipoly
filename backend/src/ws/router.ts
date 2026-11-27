/**
 * Validates each client frame and dispatches to a service. Every request
 * gets exactly one reply carrying its reqId: an ack (or typed data) or an
 * error with a stable code.
 */
import { ZodError } from 'zod';
import { env, arc } from '../config/env.js';
import { pool } from '../db/pool.js';
import { careerFor, gameReview, upsertUser, vrfContracts } from '../db/views.js';
import { verifyIdentityToken } from '../auth/privy.js';
import { treasuryAddress } from '../chain/usdc.js';
import { AppError, forbidden } from '../errors.js';
import { createLobby, joinLobby, leaveLobby, readyUp, unready } from '../services/lobby.js';
import { placePick } from '../services/game.js';
import { leaderboardFor } from '../services/leaderboard.js';
import { log } from '../log.js';
import { clientMessageSchema, type ClientMessage } from '../shared/protocol.js';
import { bindUser, unwatchLobby, watchList, watchLobby, type Session } from './hub.js';

type Handler<T extends ClientMessage['type']> = (
  s: Session & { userId: string },
  msg: Extract<ClientMessage, { type: T }>,
) => Promise<unknown>;

/**
 * The identity token can predate the embedded wallet (Privy creates it right
 * after first login). Fall back to the address another session stored.
 */
async function walletOf(s: Session & { userId: string }): Promise<string | null> {
  if (!s.walletAddress) {
    const res = await pool.query<{ wallet_address: string | null }>(
      'select wallet_address from public.app_users where privy_user_id = $1',
      [s.userId],
    );
    s.walletAddress = res.rows[0]?.wallet_address ?? null;
  }
  return s.walletAddress;
}

const handlers: { [T in Exclude<ClientMessage['type'], 'auth'>]: Handler<T> } = {
  'lobbies.watch': (s) => watchList(s),
  'lobby.watch': (s, m) => watchLobby(s, m.lobbyId),
  'lobby.unwatch': async (s) => unwatchLobby(s),
  'lobby.create': async (s, m) => {
    const lobbyId = await createLobby(s.userId, m.name, m.displayName, BigInt(m.buyIn));
    await watchLobby(s, lobbyId);
    return { lobbyId };
  },
  'lobby.join': async (s, m) => {
    await joinLobby(s.userId, m.lobbyId, m.displayName);
    await watchLobby(s, m.lobbyId);
  },
  'lobby.leave': async (s, m) => {
    await leaveLobby(s.userId, m.lobbyId);
    unwatchLobby(s);
  },
  'lobby.ready': async (s, m) => readyUp(s.userId, await walletOf(s), m.lobbyId, m.txHash),
  'lobby.unready': (s, m) => unready(s.userId, m.lobbyId),
  'game.pick': async (s, m) =>
    placePick({
      userId: s.userId,
      walletAddress: m.sideBet && m.sideBet !== '0' ? await walletOf(s) : s.walletAddress,
      gameId: m.gameId,
      roundNumber: m.roundNumber,
      direction: m.direction,
      sideBet: BigInt(m.sideBet ?? '0'),
      txHash: m.txHash,
      arrivedAt: new Date(),
    }),
  'game.review': async (s, m) => {
    const review = await gameReview(pool, m.gameId, s.userId, treasuryAddress);
    if (!review) throw forbidden('you were not in this game');
    return review;
  },
  'career.get': async (s, m) => {
    s.send({ type: 'career', reqId: m.reqId, games: await careerFor(pool, s.userId) });
    return undefined;
  },
  'leaderboard.get': async (s) => leaderboardFor(s.userId),
};

async function authenticate(s: Session, msg: Extract<ClientMessage, { type: 'auth' }>) {
  const { userId, walletAddress } = await verifyIdentityToken(msg.token);
  await upsertUser(pool, userId, walletAddress);
  s.userId = userId;
  s.walletAddress = walletAddress;
  bindUser(s);
  s.send({
    type: 'auth_ok',
    reqId: msg.reqId,
    userId,
    walletAddress,
    network: arc.network,
    treasury: treasuryAddress,
    vrfContracts: vrfContracts(),
    limits: {
      minBuyIn: env.MIN_BUY_IN_USDC.toString(),
      maxBuyIn: env.MAX_BUY_IN_USDC.toString(),
      maxSideBet: env.MAX_SIDE_BET_USDC.toString(),
    },
    timing: { bettingMs: env.BETTING_SECONDS * 1000, rollingMs: env.ROLLING_MS },
    serverNow: Date.now(),
  });
}

export async function route(s: Session, raw: string): Promise<void> {
  let reqId: string | undefined;
  try {
    const parsed = clientMessageSchema.parse(JSON.parse(raw));
    reqId = parsed.reqId;
    if (parsed.type === 'auth') return await authenticate(s, parsed);
    if (!s.userId) throw new AppError('UNAUTHENTICATED', 'sign in first');

    const handler = handlers[parsed.type] as Handler<typeof parsed.type>;
    const data = await handler(s as Session & { userId: string }, parsed as never);
    if (parsed.type !== 'career.get') s.send({ type: 'ack', reqId, data });
  } catch (err) {
    if (err instanceof AppError) {
      s.send({ type: 'error', reqId, code: err.code, message: err.message });
    } else if (err instanceof ZodError || err instanceof SyntaxError) {
      s.send({ type: 'error', reqId, code: 'BAD_REQUEST', message: 'malformed message' });
    } else {
      log.error({ err, userId: s.userId }, 'handler failed');
      s.send({ type: 'error', reqId, code: 'INTERNAL', message: 'something went wrong on our side' });
    }
  }
}
