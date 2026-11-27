// The browser verifier (src/lib/fairness.ts) decides the review's "✓ fair" /
// "✗ mismatch" badge. It must agree with the server and the contract.
// (contracts/test/backend-oracle.test.ts also runs it against a real chain.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { ballFromRandomWord, gameIdToBytes16 } from '../src/domain/fairness.ts';
import { encodeAbiParameters, keccak256 } from 'viem';

// Any uint256 works as an Arc VRF word; derive reproducible ones for the tests.
const expandRandomWords = (seed: bigint, n: number) =>
  Array.from({ length: n }, (_, i) =>
    BigInt(keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [seed, BigInt(i)]))),
  );
import { verifyLegacyRound, verifyVrfRound, type OnChainDraw } from '../../src/lib/fairness.ts';

const GAME = '0f8fad5b-d9cb-469f-a165-70867728950e';

test('server ball derivation matches the contract formula', () => {
  for (let i = 0n; i < 200n; i++) {
    const word = expandRandomWords(i, 1)[0]!;
    assert.equal(ballFromRandomWord(word), Number(word % 17n)); // AkipolyRounds: BALL_MIN + word % BALL_RANGE
  }
});

test('VRF rounds: verified only when the chain record matches', async () => {
  const word = expandRandomWords(42n, 1)[0]!;
  const ball = ballFromRandomWord(word);
  const vrf = { requestId: '777', requestTx: '0xabc', requestBlock: '10', fulfillTx: '0xdef', randomWord: word.toString() };
  const chain: OnChainDraw = { requestId: 777n, randomWord: word, fulfilled: true, ball };
  const reader = (d: OnChainDraw) => async () => d;

  assert.equal(await verifyVrfRound(reader(chain), GAME, 1, ball, vrf), 'verified');
  // Server reports a different ball than the word implies.
  assert.equal(await verifyVrfRound(reader(chain), GAME, 1, (ball + 1) % 17, vrf), 'mismatch');
  // Chain disagrees with what the server reported.
  assert.equal(await verifyVrfRound(reader({ ...chain, fulfilled: false }), GAME, 1, ball, vrf), 'mismatch');
  assert.equal(await verifyVrfRound(reader({ ...chain, requestId: 778n }), GAME, 1, ball, vrf), 'mismatch');
  const other = expandRandomWords(43n, 1)[0]!;
  assert.equal(
    await verifyVrfRound(reader({ ...chain, randomWord: other, ball: ballFromRandomWord(other) }), GAME, 1, ball, vrf),
    'mismatch',
  );
  // RPC failure is "can't check", never "mismatch".
  const down = async (): Promise<OnChainDraw> => {
    throw new Error('rpc down');
  };
  assert.equal(await verifyVrfRound(down, GAME, 1, ball, vrf), 'unavailable');
});

test('legacy rounds: commit-reveal check accepts real rounds and rejects tampering', async () => {
  for (let round = 0; round < 10; round++) {
    const seed = randomBytes(32).toString('hex');
    const seedHash = createHash('sha256').update(seed).digest('hex');
    const digest = createHmac('sha256', seed).update(`${GAME}:${round}`).digest();
    const ball = Number(digest.readBigUInt64BE(0) % 17n);
    assert.deepEqual(await verifyLegacyRound(seed, seedHash, GAME, round, ball), { hashOk: true, ballOk: true });
    assert.equal((await verifyLegacyRound(seed, seedHash, GAME, round, (ball + 1) % 17)).ballOk, false);
    assert.equal((await verifyLegacyRound(`${seed}0`, seedHash, GAME, round, ball)).hashOk, false);
  }
});

test('game ids map to the bytes16 the contract keys rounds by', () => {
  assert.equal(gameIdToBytes16('0f8fad5b-d9cb-469f-a165-70867728950e'), '0x0f8fad5bd9cb469fa16570867728950e');
  assert.throws(() => gameIdToBytes16('game-1'));
});
