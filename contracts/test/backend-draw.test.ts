/**
 * Runs the backend's real Arc VRF client (backend/src/chain/vrf.ts) against a
 * local Ganache node that impersonates Arc testnet's chain id, with a mock in
 * place of the hosted Arc VRF coordinator. Covers the treasury's request, log
 * parsing, reading the delivered ball back, the startup wiring check, and the
 * browser's review check: everything except the Postgres job table.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import ganache from 'ganache';
import { parseAbi, toEventSelector, toFunctionSelector, toHex, type Abi, type AbiEvent, type AbiFunction } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { AKIPOLY_ROUNDS_ABI, ARC_VRF_COORDINATOR_ABI } from '../../backend/src/shared/vrf.js';
import { artifact, KEY_HASH, SUB_ID } from './helpers.js';
import { verifyVrfRound } from '../../src/lib/fairness.js';

const MNEMONIC = 'myth like bonus scare over problem client lizard pioneer submit female collect';
const PORT = 18545;
const ARC_TESTNET_CHAIN_ID = 5042002;
const GAME = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('shared ABIs match the compiled contracts', () => {
  const check = (human: readonly string[], compiled: Abi) => {
    const sigs = new Set(
      compiled.flatMap((i) =>
        i.type === 'function' ? [toFunctionSelector(i as AbiFunction)] : i.type === 'event' ? [toEventSelector(i as AbiEvent)] : [],
      ),
    );
    for (const item of parseAbi(human)) {
      if (item.type === 'function') assert.ok(sigs.has(toFunctionSelector(item)), `missing function ${item.name}`);
      if (item.type === 'event') assert.ok(sigs.has(toEventSelector(item)), `missing event ${item.name}`);
    }
  };
  it('AkipolyRounds', () => check(AKIPOLY_ROUNDS_ABI, artifact('AkipolyRounds').abi));
  it('Arc VRF coordinator (as mocked)', () => check(ARC_VRF_COORDINATOR_ABI, artifact('MockArcVRFCoordinator').abi));
});

describe('backend Arc VRF client against a live node', () => {
  const server = ganache.server({
    logging: { quiet: true },
    wallet: { mnemonic: MNEMONIC, totalAccounts: 3 },
    chain: { hardfork: 'shanghai', chainId: ARC_TESTNET_CHAIN_ID, vmErrorsOnRPCResponse: false },
    miner: { instamine: 'eager' },
  });
  const deployer = mnemonicToAccount(MNEMONIC, { addressIndex: 0 });
  const treasury = mnemonicToAccount(MNEMONIC, { addressIndex: 1 });
  let vrf: typeof import('../../backend/src/chain/vrf.js');
  let usdc: typeof import('../../backend/src/chain/usdc.js');
  let coordinator: `0x${string}`;
  let rounds: `0x${string}`;
  let send: (address: `0x${string}`, abi: Abi, functionName: string, args: unknown[]) => Promise<void>;

  before(async () => {
    await server.listen(PORT);
    const rpcUrl = `http://127.0.0.1:${PORT}`;
    const { createPublicClient, createWalletClient, http, defineChain } = await import('viem');
    const chain = defineChain({
      id: ARC_TESTNET_CHAIN_ID,
      name: 'arc-sim',
      nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    });
    const pub = createPublicClient({ chain, transport: http(rpcUrl), pollingInterval: 20 });
    const wallet = createWalletClient({ chain, transport: http(rpcUrl), account: deployer });
    const deploy = async (name: string, args: unknown[] = []) => {
      const a = artifact(name);
      const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode, args });
      return (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
    };
    send = async (address, abi, functionName, args) => {
      const hash = await wallet.writeContract({ address, abi, functionName, args } as never);
      await pub.waitForTransactionReceipt({ hash });
    };
    coordinator = await deploy('MockArcVRFCoordinator');
    rounds = await deploy('AkipolyRounds', [coordinator, treasury.address, KEY_HASH, SUB_ID, 0, 150_000]);
    await send(coordinator, artifact('MockArcVRFCoordinator').abi, 'addConsumer', [SUB_ID, rounds]);

    // Configure the backend exactly as production would, then load its modules.
    Object.assign(process.env, {
      DATABASE_URL: 'postgres://unused/unused',
      PRIVY_APP_ID: 'test',
      ARC_NETWORK: 'testnet',
      ARC_RPC_URL: rpcUrl,
      TREASURY_PRIVATE_KEY: toHex(treasury.getHdKey().privateKey!),
      VRF_ROUNDS_ADDRESS: rounds,
      VRF_SUBSCRIPTION_ID: SUB_ID.toString(),
      VRF_COORDINATOR_ADDRESS: coordinator,
      VRF_KEY_HASH: KEY_HASH,
    });
    usdc = await import('../../backend/src/chain/usdc.js');
    vrf = await import('../../backend/src/chain/vrf.js');
  });

  after(async () => {
    await server.close();
  });

  it('startup check passes for a correctly wired deployment', async () => {
    assert.deepEqual(await vrf.checkVrfSetup(), { mismatches: [], warnings: [], unreachable: null });
  });

  it('treasury requests, Arc VRF delivers, the ball is read back on-chain', async () => {
    const pub = usdc.publicClient;
    const req = await vrf.signRequestBall(GAME, 1);
    await usdc.broadcast(req.raw);
    const receipt = await pub.waitForTransactionReceipt({ hash: req.hash });
    assert.equal(receipt.status, 'success');
    const parsed = vrf.parseRequest(receipt);
    assert.ok(parsed, 'BallRequested parsed');

    assert.equal((await vrf.readDraw(GAME, 1)).fulfilled, false, 'nothing until the VRF answers');

    const word = 2n ** 200n + 31n;
    await send(coordinator, artifact('MockArcVRFCoordinator').abi, 'fulfill', [parsed.requestId, word]);

    const draw = await vrf.readDraw(GAME, 1);
    assert.equal(draw.fulfilled, true);
    assert.equal(draw.requestId, parsed.requestId);
    assert.equal(draw.randomWord, word);
    assert.equal(draw.ball, Number(word % 17n));
    const fulfillTx = await vrf.findFulfillTx(GAME, 1, parsed.blockNumber);
    assert.ok(fulfillTx, 'BallDrawn tx found');

    // The browser's review check, reading this same chain.
    const reported = {
      requestId: parsed.requestId.toString(),
      requestTx: req.hash,
      requestBlock: parsed.blockNumber.toString(),
      fulfillTx,
      randomWord: word.toString(),
    };
    const readDraw = (g: string, n: number) => vrf.readDraw(g, n);
    assert.equal(await verifyVrfRound(readDraw, GAME, 1, draw.ball, reported), 'verified');
    assert.equal(await verifyVrfRound(readDraw, GAME, 1, (draw.ball + 1) % 17, reported), 'mismatch');
    assert.equal(await verifyVrfRound(readDraw, GAME, 2, draw.ball, reported), 'mismatch'); // never drawn
  });

  it('the treasury cannot re-request a round', async () => {
    await assert.rejects(vrf.signRequestBall(GAME, 1)); // gas estimation hits AlreadyRequested
  });
});
