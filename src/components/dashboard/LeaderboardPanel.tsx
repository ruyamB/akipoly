import { useCallback, useEffect, useState } from 'react';
import type { LeaderboardEntry, LeaderboardView } from '@shared/protocol';
import { useGameSocket } from '../../features/game/GameSocket';
import { addressUrl, formatUsdc } from '../../lib/arc';

const shorten = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const MEDALS = ['🥇', '🥈', '🥉'];

function Row({ e, minGames }: { e: LeaderboardEntry; minGames: number }) {
  const net = BigInt(e.net);
  const label = e.name || (e.walletAddress ? shorten(e.walletAddress) : 'player');
  return (
    <li className={`career__row ${e.isMe ? 'lb__me' : ''}`}>
      <span className="career__place lb__rank">{e.rank === null ? '—' : (MEDALS[e.rank - 1] ?? `#${e.rank}`)}</span>
      <span className="career__meta">
        <strong>
          {e.walletAddress ? (
            <a className="lb__wallet" href={addressUrl(e.walletAddress)} target="_blank" rel="noreferrer">
              {label}
            </a>
          ) : (
            label
          )}
          {e.isMe && <span className="lb__you"> (you)</span>}
        </strong>
        <small>
          {e.rank === null
            ? `${e.games}/${minGames} games to rank`
            : `${Math.round((e.wins / e.games) * 100)}% · ${e.wins}/${e.games} wins`}
        </small>
      </span>
      <span className={`career__pts ${net >= 0n ? 'career__pts--up' : 'career__pts--down'}`}>
        {net >= 0n ? '+' : '−'}
        {formatUsdc(net < 0n ? -net : net)} usdc
      </span>
    </li>
  );
}

export default function LeaderboardPanel() {
  const { request, status } = useGameSocket();
  const [board, setBoard] = useState<LeaderboardView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    setBoard(null);
    request<LeaderboardView>({ type: 'leaderboard.get' })
      .then(setBoard)
      .catch((err: Error) => setError(`couldn't load the leaderboard — ${err.message}`));
  }, [request]);

  useEffect(() => {
    if (status === 'ready') load();
  }, [status, load]);

  if (error) {
    return (
      <div className="career__error">
        {error}
        <button type="button" className="btn career__retry" onClick={load}>
          try again
        </button>
      </div>
    );
  }

  if (!board) return <p className="career__loading">tallying games…</p>;

  if (board.entries.length === 0 && !board.me) {
    return (
      <div className="career__empty">
        <p className="career__empty-title">no ranked players yet.</p>
        <p>finish {board.minGames} games to get on the board.</p>
      </div>
    );
  }

  return (
    <div className="career">
      <div className="career__header">
        <h3 className="career__title">top players</h3>
        <button type="button" className="career__refresh" onClick={load} aria-label="Refresh">
          ↻
        </button>
      </div>
      <ol className="career__list">
        {board.entries.map((e, i) => (
          <Row key={i} e={e} minGames={board.minGames} />
        ))}
        {board.me && (
          <>
            <li className="lb__divider" aria-hidden="true">
              ⋯
            </li>
            <Row e={board.me} minGames={board.minGames} />
          </>
        )}
      </ol>
      <p className="lb__note">
        win rate over finished games · min {board.minGames} games to rank · {board.total}{' '}
        {board.total === 1 ? 'player' : 'players'} ranked
      </p>
    </div>
  );
}
