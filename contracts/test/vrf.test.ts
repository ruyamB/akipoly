/**
 * AkipolyRounds as an Arc VRF consumer, against a recording mock coordinator.
 * The hosted Arc VRF verifies proofs itself; what we must get right here is
 * the request we send and how we treat the callback.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeAbiParameters, keccak256, parseEventLogs, slice, toBytes } from 'viem';
import { KEY_HASH, SUB_ID, expectRevert, gameId, setup } from './helpers.js';

describe('AkipolyRounds on Arc VRF', async () => {
  const t = await setup();
  const { rounds, coordinator } = t.addresses;
  const { roundsAbi, coordAbi } = t.abis;

  const drawOf = (g: `0x${string}`, round: number) =>
    t.pub.readContract({ address: rounds, abi: roundsAbi, functionName: 'drawOf', args: [g, round] }) as Promise<{
      requestId: bigint;
      randomWord: bigint;
      fulfilled: boolean;
      ball: number;
    }>;

  it('sends the subscription, key hash and native payment with every request', async () => {
    const { requestId } = await t.requestBall(gameId(1), 1);
    const [sender, keyHash, subId, confirmations, gasLimit, numWords, extraArgs] = (await t.pub.readContract({
      address: coordinator,
      abi: coordAbi,
      functionName: 'requests',
      args: [requestId],
    })) as [string, string, bigint, number, number, number, `0x${string}`];
    assert.equal(sender.toLowerCase(), rounds.toLowerCase());
    assert.equal(keyHash, KEY_HASH);
    assert.equal(subId, SUB_ID);
    assert.equal(confirmations, 0);
    assert.equal(gasLimit, 150_000);
    assert.equal(numWords, 1);
    // extraArgs = tag("VRF ExtraArgsV1") ++ abi.encode(ExtraArgsV1{nativePayment: true})
    assert.equal(slice(extraArgs, 0, 4), slice(keccak256(toBytes('VRF ExtraArgsV1')), 0, 4));
    const [nativePayment] = decodeAbiParameters([{ type: 'bool' }], slice(extraArgs, 4));
    assert.equal(nativePayment, true);
  });

  it('only the requester can request, and each round only once', async () => {
    await expectRevert(t.requestBall(gameId(2), 1, t.accounts.stranger), 'OnlyRequester');
    await t.requestBall(gameId(2), 1);
    await expectRevert(t.requestBall(gameId(2), 1), 'AlreadyRequested');
    await t.requestBall(gameId(2), 2); // the next round is a new draw
  });

  it('turns the delivered word into the ball on-chain', async () => {
    const { requestId } = await t.requestBall(gameId(3), 1);
    assert.equal((await drawOf(gameId(3), 1)).fulfilled, false);
    const word = 2n ** 255n + 12345n;
    const receipt = await t.fulfill(requestId, word);
    const d = await drawOf(gameId(3), 1);
    assert.equal(d.fulfilled, true);
    assert.equal(d.requestId, requestId);
    assert.equal(d.randomWord, word);
    assert.equal(d.ball, Number(word % 17n));
    assert.ok(receipt.logs.some((l) => l.address.toLowerCase() === rounds.toLowerCase()), 'BallDrawn emitted');
  });

  it('only the coordinator can deliver a word', async () => {
    const { requestId } = await t.requestBall(gameId(4), 1);
    await expectRevert(
      t.send(t.accounts.stranger, rounds, roundsAbi, 'rawFulfillRandomWords', [requestId, [7n]]),
      'OnlyCoordinatorCanFulfill',
    );
  });

  it('ignores a second answer and answers it never asked for, without reverting', async () => {
    const { requestId } = await t.requestBall(gameId(5), 1);
    await t.fulfill(requestId, 17n * 3n + 5n); // ball 5
    await t.fulfill(requestId, 17n * 3n + 9n); // must not overwrite
    assert.equal((await drawOf(gameId(5), 1)).ball, 5);
    // An unknown request id: the callback returns quietly (a revert would still be charged).
    await t.send(t.accounts.fulfiller, coordinator, coordAbi, 'fulfillRaw', [rounds, 999_999n, 1n]);
  });

  it('a callback that runs out of gas leaves the draw empty and is reported as failed', async () => {
    await t.send(t.accounts.owner, rounds, roundsAbi, 'setRequestParams', [KEY_HASH, SUB_ID, 0, 5_000]);
    try {
      const { requestId } = await t.requestBall(gameId(6), 1);
      const receipt = await t.fulfill(requestId, 42n);
      assert.equal((await drawOf(gameId(6), 1)).fulfilled, false);
      const [ev] = parseEventLogs({ abi: coordAbi, logs: receipt.logs, eventName: 'RandomWordsFulfilled' }) as unknown as {
        args: { requestId: bigint; success: boolean };
      }[];
      assert.equal(ev!.args.requestId, requestId);
      assert.equal(ev!.args.success, false);
    } finally {
      await t.send(t.accounts.owner, rounds, roundsAbi, 'setRequestParams', [KEY_HASH, SUB_ID, 0, 150_000]);
    }
  });

  it('only the owner can change the subscription or key', async () => {
    await expectRevert(
      t.send(t.accounts.stranger, rounds, roundsAbi, 'setRequestParams', [KEY_HASH, 1n, 0, 150_000]),
      'OnlyOwner',
    );
    await t.send(t.accounts.owner, rounds, roundsAbi, 'setRequestParams', [KEY_HASH, 77n, 0, 150_000]);
    assert.equal(await t.pub.readContract({ address: rounds, abi: roundsAbi, functionName: 'subId' }), 77n);
    await t.send(t.accounts.owner, rounds, roundsAbi, 'setRequestParams', [KEY_HASH, SUB_ID, 0, 150_000]);
  });
});
