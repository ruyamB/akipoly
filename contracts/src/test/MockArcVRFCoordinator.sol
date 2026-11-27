// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ArcVRFClient} from "../ArcVRFClient.sol";

interface IRawFulfill {
  function rawFulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external;
}

/**
 * @title MockArcVRFCoordinator
 * @notice TEST ONLY. Stands in for the hosted Arc VRF coordinator: records each
 * request exactly as the real one receives it and lets a test deliver a word.
 * Never deploy this outside tests.
 */
contract MockArcVRFCoordinator {
  struct Recorded {
    address sender;
    bytes32 keyHash;
    uint256 subId;
    uint16 requestConfirmations;
    uint32 callbackGasLimit;
    uint32 numWords;
    bytes extraArgs;
  }

  uint256 public nextRequestId = 1;
  mapping(uint256 => Recorded) public requests;
  mapping(uint256 => address[]) internal s_consumers;

  event RandomWordsRequested(uint256 indexed requestId, address indexed sender, uint256 subId);
  /// @dev Same signature as the real coordinator's; success=false when the callback failed.
  event RandomWordsFulfilled(
    uint256 indexed requestId,
    uint256 outputSeed,
    uint256 indexed subId,
    uint96 payment,
    bool nativePayment,
    bool success,
    bool onlyPremium
  );

  function requestRandomWords(ArcVRFClient.RandomWordsRequest calldata req) external returns (uint256 requestId) {
    requestId = nextRequestId++;
    requests[requestId] = Recorded({
      sender: msg.sender,
      keyHash: req.keyHash,
      subId: req.subId,
      requestConfirmations: req.requestConfirmations,
      callbackGasLimit: req.callbackGasLimit,
      numWords: req.numWords,
      extraArgs: req.extraArgs
    });
    emit RandomWordsRequested(requestId, msg.sender, req.subId);
  }

  /// @notice Deliver a word the way the real coordinator does after verifying its proof:
  /// with exactly the request's callbackGasLimit, reporting (not reverting on) a failed callback.
  function fulfill(uint256 requestId, uint256 word) external {
    Recorded memory r = requests[requestId];
    require(r.sender != address(0), "unknown request");
    // Like the real coordinator: refuse rather than hand the callback less gas than promised.
    require(gasleft() > (uint256(r.callbackGasLimit) * 64) / 63 + 10_000, "not enough gas for callback");
    uint256[] memory words = new uint256[](1);
    words[0] = word;
    (bool success, ) = r.sender.call{gas: r.callbackGasLimit}(
      abi.encodeCall(IRawFulfill.rawFulfillRandomWords, (requestId, words))
    );
    emit RandomWordsFulfilled(requestId, word, r.subId, 0, true, success, false);
  }

  /// @notice Call a consumer's callback directly (e.g. for an id it never asked for).
  function fulfillRaw(address consumer, uint256 requestId, uint256 word) external {
    uint256[] memory words = new uint256[](1);
    words[0] = word;
    IRawFulfill(consumer).rawFulfillRandomWords(requestId, words);
  }

  /// @notice Every non-zero key hash counts as registered.
  function s_provingKeys(bytes32 keyHash) external pure returns (bool exists, uint64 maxGas) {
    return (keyHash != bytes32(0), 0);
  }

  function addConsumer(uint256 subId, address consumer) external {
    s_consumers[subId].push(consumer);
  }

  function getSubscription(uint256 subId)
    external
    view
    returns (uint96 balance, uint96 nativeBalance, uint64 reqCount, address owner, address[] memory consumers)
  {
    return (0, 5 ether, 0, address(this), s_consumers[subId]);
  }
}
