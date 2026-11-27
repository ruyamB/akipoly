// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VRFConsumerBase} from "./VRFConsumerBase.sol";
import {ArcVRFClient, IArcVRFCoordinator} from "./ArcVRFClient.sol";

/**
 * @title AkipolyRounds
 * @notice On-chain record of every Akipoly ball. The treasury requests one VRF
 * draw per (game, round) when betting closes, paid from an Arc VRF subscription
 * (https://arcvrf.007575.xyz). The Arc VRF coordinator verifies the proof
 * on-chain and calls back, and this contract turns the word into the ball digit:
 *
 *     ball = BALL_MIN + randomWords[0] % BALL_RANGE        (0..16)
 *
 * The digit is computed here, on-chain. The game server only reads it.
 *
 * Each round can be requested exactly once. There is no cancel and no re-request,
 * so nobody, the treasury included, can throw away a result and roll again.
 */
contract AkipolyRounds is VRFConsumerBase {
  uint8 public constant BALL_MIN = 0;
  uint8 public constant BALL_RANGE = 17; // balls 0..16
  uint32 public constant NUM_WORDS = 1;

  error OnlyOwner();
  error OnlyRequester();
  error AlreadyRequested(bytes16 gameId, uint32 round);

  event RequesterSet(address requester);
  event RequestParamsSet(bytes32 keyHash, uint256 subId, uint16 requestConfirmations, uint32 callbackGasLimit);
  event BallRequested(bytes16 indexed gameId, uint32 indexed round, uint256 requestId);
  event BallDrawn(bytes16 indexed gameId, uint32 indexed round, uint256 requestId, uint256 randomWord, uint8 ball);

  struct Draw {
    uint256 requestId;
    uint256 randomWord;
    uint64 requestedAt; // block number of the request
    bool fulfilled;
    uint8 ball;
  }

  struct RoundRef {
    bytes16 gameId;
    uint32 round;
  }

  address public owner;
  address public requester;
  bytes32 public keyHash;
  /// @notice Arc VRF subscription that pays for every draw (this contract must be a consumer).
  uint256 public subId;
  uint16 public requestConfirmations;
  uint32 public callbackGasLimit;

  mapping(bytes32 roundKey => Draw) internal s_draws;
  mapping(uint256 requestId => RoundRef) public roundOfRequest;

  constructor(
    address coordinator,
    address requester_,
    bytes32 keyHash_,
    uint256 subId_,
    uint16 requestConfirmations_,
    uint32 callbackGasLimit_
  ) VRFConsumerBase(coordinator) {
    owner = msg.sender;
    requester = requester_;
    keyHash = keyHash_;
    subId = subId_;
    requestConfirmations = requestConfirmations_;
    callbackGasLimit = callbackGasLimit_;
    emit RequesterSet(requester_);
    emit RequestParamsSet(keyHash_, subId_, requestConfirmations_, callbackGasLimit_);
  }

  modifier onlyOwner() {
    if (msg.sender != owner) revert OnlyOwner();
    _;
  }

  function setRequester(address requester_) external onlyOwner {
    requester = requester_;
    emit RequesterSet(requester_);
  }

  /// @notice e.g. to move to a new subscription or key. Doesn't affect requests already made.
  function setRequestParams(bytes32 keyHash_, uint256 subId_, uint16 confirmations_, uint32 gasLimit_) external onlyOwner {
    keyHash = keyHash_;
    subId = subId_;
    requestConfirmations = confirmations_;
    callbackGasLimit = gasLimit_;
    emit RequestParamsSet(keyHash_, subId_, confirmations_, gasLimit_);
  }

  function roundKey(bytes16 gameId, uint32 round) public pure returns (bytes32) {
    return keccak256(abi.encode(gameId, round));
  }

  /**
   * @notice Ask the coordinator for this round's ball. Call it only after betting
   * has closed, and only once per round.
   */
  function requestBall(bytes16 gameId, uint32 round) external returns (uint256 requestId) {
    if (msg.sender != requester) revert OnlyRequester();
    bytes32 key = roundKey(gameId, round);
    if (s_draws[key].requestId != 0) revert AlreadyRequested(gameId, round);

    requestId = IArcVRFCoordinator(COORDINATOR).requestRandomWords(
      ArcVRFClient.RandomWordsRequest({
        keyHash: keyHash,
        subId: subId,
        requestConfirmations: requestConfirmations,
        callbackGasLimit: callbackGasLimit,
        numWords: NUM_WORDS,
        extraArgs: ArcVRFClient.nativeExtraArgs()
      })
    );
    s_draws[key] = Draw({
      requestId: requestId,
      randomWord: 0,
      requestedAt: uint64(block.number),
      fulfilled: false,
      ball: 0
    });
    roundOfRequest[requestId] = RoundRef({gameId: gameId, round: round});
    emit BallRequested(gameId, round, requestId);
  }

  // Must not revert (Chainlink security considerations): only store and emit.
  function fulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) internal override {
    RoundRef memory ref = roundOfRequest[requestId];
    bytes32 key = roundKey(ref.gameId, ref.round);
    Draw storage d = s_draws[key];
    if (d.requestId != requestId || d.fulfilled || randomWords.length == 0) return;
    uint8 ball = uint8(BALL_MIN + (randomWords[0] % BALL_RANGE));
    d.fulfilled = true;
    d.randomWord = randomWords[0];
    d.ball = ball;
    emit BallDrawn(ref.gameId, ref.round, requestId, randomWords[0], ball);
  }

  /// @notice The draw for a round. fulfilled=false means the VRF hasn't answered yet.
  function drawOf(bytes16 gameId, uint32 round) external view returns (Draw memory) {
    return s_draws[roundKey(gameId, round)];
  }

  function ballOf(bytes16 gameId, uint32 round) external view returns (bool fulfilled, uint8 ball) {
    Draw storage d = s_draws[roundKey(gameId, round)];
    return (d.fulfilled, d.ball);
  }
}
