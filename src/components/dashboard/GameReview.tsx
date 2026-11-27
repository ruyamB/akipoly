import { useEffect, useMemo, useState } from 'react';
import type { GameReview as Review, LedgerEntry, ReviewRound } from '@shared/protocol';
import { useGameSocket } from '../../features/game/GameSocket';
import { BALL_COLORS, DARK_BALLS } from '../../features/game/BallReel';
import { addressUrl, formatUsdc, readRoundDraw, txUrl } from '../../lib/arc';
import { verifyLegacyRound, verifyVrfRound } from '../../lib/fairness';
import { vrfProofUrl } from '@shared/vrf';

interface Props {
  gameId: string;
  onBack: () => void;
}

const kindLabel: Record<LedgerEntry['kind'], string> = {
  buy_in: 'buy-in',
  side_bet: 'side bet',
  pot: 'pot won',
  split: 'pot split',
  side_win: 'side bet won',
  side_refund: 'side bet refunded',
  refund: 'refund',
};

const outcomeLabel: Record<ReviewRound['outcome'], string> = {
  higher: 'higher',
  lower: 'lower',
  push: 'push',
  void: 'void',
  opening: 'opening ball',
};

const pad = (n: number | null) => (n === null ? '—' : String(n).padStart(2, '0'));
const shortHash = (h: string) => `${h.slice(0, 8)}…${h.slice(-6)}`;
const usdc = (v: bigint | string) => `${formatUsdc(v)} usdc`;

function Ball({ n }: { n: number }) {
  return (
    <span
      className="review__ball"
      style={{ backgroundColor: BALL_COLORS[n], color: DARK_BALLS.has(n) ? '#FFFDF2' : '#171717' }}
    >
      {pad(n)}
    </span>
  );
}

type MyResult = 'survived' | 'out' | 'push' | 'watching';

export default function GameReview({ gameId, onBack }: Props) {
  const { request, status } = useGameSocket();
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState<string | null>(null);
  // true = verified, false = mismatch, null = couldn't check (chain unreachable / no https).
  const [fair, setFair] = useState<Map<number, boolean | null>>(new Map());

  useEffect(() => {
    if (status !== 'ready') return;
    setError(null);
    request<Review>({ type: 'game.review', gameId })
      .then(setReview)
      .catch((err: Error) => setError(err.message));
  }, [status, gameId, request]);

  // Re-check every ball from the browser: VRF rounds against the Arc contract
  // directly (not our server), older rounds against their revealed seed.
  useEffect(() => {
    if (!review) return;
    let cancelled = false;
    Promise.all(
      review.rounds.map(async (r): Promise<readonly [number, boolean | null]> => {
        if (r.vrf) {
          // Check against the contract that drew it, not today's (it may have been redeployed).
          if (!r.vrf.rounds) return [r.number, null] as const;
          const v = await verifyVrfRound(readRoundDraw(r.vrf.rounds), review.gameId, r.number, r.ball, r.vrf);
          return [r.number, v === 'unavailable' ? null : v === 'verified'] as const;
        }
        if (r.legacy) {
          // crypto.subtle only exists on https/localhost.
          const v = await verifyLegacyRound(r.legacy.seed, r.legacy.seedHash, review.gameId, r.number, r.ball).catch(
            () => null,
          );
          return [r.number, v ? v.hashOk && v.ballOk : null] as const;
        }
        return [r.number, false] as const; // a settled ball with no proof at all
      }),
    )
      .then((checks) => {
        if (!cancelled) setFair(new Map(checks));
      })
      .catch(() => {
        if (!cancelled) setFair(new Map(review.rounds.map((r) => [r.number, null])));
      });
    return () => {
      cancelled = true;
    };
  }, [review]);

  const analysis = useMemo(() => {
    if (!review) return null;
    const me = review.me.userId;
    const elim = review.me.eliminatedRound;
    const played = review.rounds.filter((r) => r.number > 0);
    const aliveAt = (n: number) => elim === null || elim >= n;

    const resultFor = (r: ReviewRound): MyResult => {
      if (r.number === 0 || !aliveAt(r.number)) return 'watching';
      if (elim === r.number) return 'out';
      if (r.outcome === 'push' || r.outcome === 'void') return 'push';
      return 'survived';
    };

    let calls = 0;
    let right = 0;
    let sideWon = 0;
    let sideLost = 0;
    let sideRefunded = 0;
    for (const r of played) {
      const pick = r.picks.find((p) => p.userId === me);
      if (pick && (r.outcome === 'higher' || r.outcome === 'lower')) {
        calls += 1;
        if (pick.direction === r.outcome) right += 1;
      }
      if (pick && BigInt(pick.sideBet) > 0n) {
        const res = r.sideResults.find((s) => s.userId === me);
        if (!res) sideLost += 1;
        else if (res.reason === 'side_win') sideWon += 1;
        else sideRefunded += 1;
      }
    }

    const totalIn = review.ledger.filter((l) => l.flow === 'in').reduce((s, l) => s + BigInt(l.amount), 0n);
    const totalOut = review.ledger
      .filter((l) => l.flow === 'out' && l.status !== 'failed')
      .reduce((s, l) => s + BigInt(l.amount), 0n);
    const unsettledOut = review.ledger.some((l) => l.flow === 'out' && l.status !== 'confirmed');

    return {
      resultFor,
      roundsPlayed: played.filter((r) => aliveAt(r.number)).length,
      roundsSurvived: played.filter((r) => aliveAt(r.number) && elim !== r.number).length,
      calls,
      right,
      sideWon,
      sideLost,
      sideRefunded,
      totalIn,
      totalOut,
      net: totalOut - totalIn,
      unsettledOut,
    };
  }, [review]);

  if (error) {
    return (
      <div className="career__error">
        {error}
        <button type="button" className="btn career__retry" onClick={onBack}>
          back to career
        </button>
      </div>
    );
  }
  if (!review || !analysis) return <p className="career__loading">loading the replay…</p>;

  const names = new Map(review.players.map((p) => [p.userId, p.displayName]));
  const nameOf = (id: string) => names.get(id) ?? 'someone';
  const isMe = (id: string) => id === review.me.userId;
  const winner = review.winnerUserId ? nameOf(review.winnerUserId) : null;
  const accuracy = analysis.calls ? Math.round((analysis.right / analysis.calls) * 100) : null;
  const placement = review.me.placement;

  return (
    <div className="review">
      <button type="button" className="review__back" onClick={onBack}>
        ‹ career
      </button>

      <header className="review__head">
        <h2 className="dash__heading">{review.lobbyName}</h2>
        <p className="review__sub">
          {new Date(review.startedAt).toLocaleString()} · buy-in {usdc(review.buyIn)} · {review.players.length} players
          {review.status === 'live' && ' · still playing'}
        </p>
        <p className="review__verdict">
          {placement === 1 ? '🏆 you won this table.' : winner ? `${winner} won this table.` : 'no single winner.'}
        </p>
      </header>

      <section className="review__summary" aria-label="Summary">
        <div className="review__stat">
          <span>placement</span>
          <strong>{placement === 1 ? '🏆 1st' : placement ? `#${placement}` : '—'}</strong>
        </div>
        <div className="review__stat">
          <span>money in</span>
          <strong>{usdc(analysis.totalIn)}</strong>
        </div>
        <div className="review__stat">
          <span>money out{analysis.unsettledOut ? ' *' : ''}</span>
          <strong>{usdc(analysis.totalOut)}</strong>
        </div>
        <div className={`review__stat review__stat--${analysis.net >= 0n ? 'up' : 'down'}`}>
          <span>net</span>
          <strong>
            {analysis.net >= 0n ? '+' : '−'}
            {usdc(analysis.net >= 0n ? analysis.net : -analysis.net)}
          </strong>
        </div>
        <div className="review__stat">
          <span>rounds survived</span>
          <strong>
            {analysis.roundsSurvived}/{analysis.roundsPlayed}
          </strong>
        </div>
        <div className="review__stat">
          <span>calls right</span>
          <strong>
            {analysis.right}/{analysis.calls}
            {accuracy !== null && ` · ${accuracy}%`}
          </strong>
        </div>
        <div className="review__stat">
          <span>side bets</span>
          <strong>
            {analysis.sideWon}w · {analysis.sideLost}l{analysis.sideRefunded ? ` · ${analysis.sideRefunded}r` : ''}
          </strong>
        </div>
        <div className="review__stat">
          <span>pot · fee</span>
          <strong>
            {formatUsdc(review.pot)} · {formatUsdc(review.fee)}
          </strong>
        </div>
      </section>
      {analysis.unsettledOut && <p className="review__note">* includes payouts still on their way.</p>}

      <section aria-labelledby="review-path">
        <h3 id="review-path" className="review__title">
          ball path
        </h3>
        <ol className="review__path">
          {review.rounds.map((r) => {
            const res = analysis.resultFor(r);
            return (
              <li key={r.number} className={`review__step review__step--${r.outcome}`}>
                <Ball n={r.ball} />
                <small>{r.number === 0 ? 'start' : `r${r.number}`}</small>
                <span className={`review__mark review__mark--${res}`} aria-label={res}>
                  {res === 'survived' ? '✓' : res === 'out' ? '✗' : res === 'push' ? '=' : ''}
                </span>
              </li>
            );
          })}
        </ol>
      </section>

      <section aria-labelledby="review-money">
        <h3 id="review-money" className="review__title">
          your money
        </h3>
        {review.ledger.length === 0 ? (
          <p className="review__note">no transfers recorded for you in this game.</p>
        ) : (
          <table className="review__ledger">
            <thead>
              <tr>
                <th>when</th>
                <th>round</th>
                <th>what</th>
                <th>amount</th>
                <th>status</th>
                <th>tx</th>
              </tr>
            </thead>
            <tbody>
              {review.ledger.map((l, i) => (
                <tr key={`${l.txHash ?? 'q'}-${i}`}>
                  <td data-label="when">{new Date(l.at).toLocaleTimeString()}</td>
                  <td data-label="round">{l.roundNumber ?? '—'}</td>
                  <td data-label="what">{kindLabel[l.kind]}</td>
                  <td data-label="amount" className={`review__amt review__amt--${l.flow}`}>
                    {l.flow === 'in' ? '−' : '+'}
                    {usdc(l.amount)}
                  </td>
                  <td data-label="status">
                    <span className={`review__badge review__badge--${l.status}`}>{l.status}</span>
                  </td>
                  <td data-label="tx">
                    {l.txHash ? (
                      <a href={txUrl(l.txHash)} target="_blank" rel="noopener noreferrer">
                        {shortHash(l.txHash)} ↗
                      </a>
                    ) : (
                      'queued'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="review__note">
          all payments go to and come from the table treasury{' '}
          <a href={addressUrl(review.treasury)} target="_blank" rel="noopener noreferrer">
            {shortHash(review.treasury)} ↗
          </a>
        </p>
      </section>

      <section aria-labelledby="review-rounds">
        <h3 id="review-rounds" className="review__title">
          round by round
        </h3>
        <ol className="review__rounds">
          {review.rounds.map((r) => {
            const pools = r.picks.reduce(
              (acc, p) => ({ ...acc, [p.direction]: acc[p.direction] + BigInt(p.sideBet) }),
              { higher: 0n, lower: 0n },
            );
            const ok = fair.get(r.number);
            return (
              <li key={r.number} className="review__round">
                <div className="review__round-head">
                  <strong>{r.number === 0 ? 'opening' : `round ${r.number}`}</strong>
                  <span className="review__balls">
                    {r.prevBall !== null && (
                      <>
                        <Ball n={r.prevBall} /> →
                      </>
                    )}{' '}
                    <Ball n={r.ball} />
                  </span>
                  <span className={`review__outcome review__outcome--${r.outcome}`}>{outcomeLabel[r.outcome]}</span>
                  <span
                    className={`review__fair ${ok === false ? 'review__fair--bad' : ok === null ? 'review__fair--na' : ''}`}
                    title={
                      r.vrf
                        ? 'ball read from the AkipolyRounds contract on Arc; the Arc VRF proof was verified on-chain'
                        : 'ball recomputed in your browser from the revealed seed'
                    }
                  >
                    {ok === undefined ? 'checking…' : ok === null ? "can't check" : ok ? '✓ fair' : '✗ mismatch'}
                  </span>
                  {r.vrf &&
                    review.vrfContracts.vrfExplorer &&
                    r.vrf.coordinator?.toLowerCase() === review.vrfContracts.coordinator.toLowerCase() && (
                    <a
                      className="review__proof"
                      href={vrfProofUrl(review.vrfContracts.vrfExplorer, r.vrf.requestId)}
                      target="_blank"
                      rel="noreferrer"
                      title="step-by-step VRF proof for this ball on Arc VRF"
                    >
                      proof ↗
                    </a>
                  )}
                </div>

                {r.number > 0 && (
                  <table className="review__calls">
                    <tbody>
                      {r.picks.map((p) => {
                        const side = r.sideResults.find((s) => s.userId === p.userId);
                        const bet = BigInt(p.sideBet);
                        return (
                          <tr key={p.userId} className={isMe(p.userId) ? 'review__me' : ''}>
                            <td>
                              {nameOf(p.userId)}
                              {isMe(p.userId) && ' (you)'}
                            </td>
                            <td>{p.direction}</td>
                            <td>
                              {bet > 0n
                                ? `${usdc(bet)} → ${side ? `${side.reason === 'side_win' ? '+' : '↩ '}${formatUsdc(side.amount)}` : 'lost'}`
                                : '—'}
                            </td>
                            <td>{r.eliminated.includes(p.userId) ? <span className="game__out">out</span> : ''}</td>
                          </tr>
                        );
                      })}
                      {r.eliminated
                        .filter((id) => !r.picks.some((p) => p.userId === id))
                        .map((id) => (
                          <tr key={id} className={isMe(id) ? 'review__me' : ''}>
                            <td>
                              {nameOf(id)}
                              {isMe(id) && ' (you)'}
                            </td>
                            <td>no call</td>
                            <td>—</td>
                            <td>
                              <span className="game__out">out</span>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                )}
                {r.number > 0 && (pools.higher > 0n || pools.lower > 0n) && (
                  <p className="review__note">
                    side pools — higher {formatUsdc(pools.higher)} · lower {formatUsdc(pools.lower)} usdc
                  </p>
                )}
                {r.vrf && (
                  <details className="game__fair">
                    <summary>on-chain draw</summary>
                    <p>
                      request:{' '}
                      <a href={txUrl(r.vrf.requestTx)} target="_blank" rel="noreferrer">
                        <code>{shortHash(r.vrf.requestTx)}</code>
                      </a>{' '}
                      (block {r.vrf.requestBlock})
                      {r.vrf.fulfillTx && (
                        <>
                          {' '}
                          · delivered:{' '}
                          <a href={txUrl(r.vrf.fulfillTx)} target="_blank" rel="noreferrer">
                            <code>{shortHash(r.vrf.fulfillTx)}</code>
                          </a>
                        </>
                      )}
                    </p>
                    <p>
                      random word: <code>{r.vrf.randomWord}</code> · ball = word mod 17
                    </p>
                  </details>
                )}
                {r.legacy && (
                  <details className="game__fair">
                    <summary>seed (pre-VRF game)</summary>
                    <p>
                      commitment: <code>{r.legacy.seedHash}</code>
                    </p>
                    <p>
                      seed: <code>{r.legacy.seed}</code>
                    </p>
                  </details>
                )}
              </li>
            );
          })}
        </ol>
      </section>

      <section aria-labelledby="review-standings">
        <h3 id="review-standings" className="review__title">
          final standings
        </h3>
        <ul className="career__list">
          {review.players.map((p) => (
            <li key={p.userId} className={`career__row ${isMe(p.userId) ? 'review__me' : ''}`}>
              <span className="career__place">{p.placement === 1 ? '🏆' : p.placement ? `#${p.placement}` : '—'}</span>
              <span className="career__meta">
                <strong>
                  {p.displayName}
                  {isMe(p.userId) && ' (you)'}
                </strong>
                <small>
                  {p.eliminatedRound !== null
                    ? `out in round ${p.eliminatedRound}`
                    : review.status === 'live'
                      ? 'still in'
                      : p.placement === 1 && review.winnerUserId === p.userId
                        ? 'last one standing'
                        : 'shared the pot'}
                </small>
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
