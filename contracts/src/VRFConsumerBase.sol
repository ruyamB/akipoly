// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title VRFConsumerBase
 * @notice Inherit from this to receive randomness from the Arc VRF coordinator.
 * Same callback as arc-vrf's ArcVRFConsumerBase (rawFulfillRandomWords), with
 * the coordinator fixed at deploy time instead of owner-settable.
 *
 * Simplified from Chainlink's VRFConsumerBaseV2Plus (MIT License, Copyright (c) 2018 SmartContract ChainLink, Ltd.).
 * The coordinator is fixed at deploy time, and rawFulfillRandomWords only accepts
 * calls from it, so the randomness a consumer sees has always been proof-checked.
 *
 * Rules from Chainlink's VRF security considerations that consumers must follow:
 *  - match fulfillments to requests by requestId (fulfillments may arrive in any order);
 *  - never cancel or re-request randomness, and accept no inputs after requesting;
 *  - fulfillRandomWords must not revert: store the words and act on them later.
 */
abstract contract VRFConsumerBase {
  error OnlyCoordinatorCanFulfill(address have, address want);
  error ZeroAddress();

  address public immutable COORDINATOR;

  constructor(address coordinator) {
    if (coordinator == address(0)) revert ZeroAddress();
    COORDINATOR = coordinator;
  }

  /**
   * @notice Handles the VRF response. Must not revert.
   * @param requestId the id returned by the coordinator's requestRandomWords
   * @param randomWords the VRF output expanded to the requested number of words
   */
  function fulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) internal virtual;

  // The coordinator calls this after verifying the proof. It checks the caller and
  // then calls fulfillRandomWords.
  function rawFulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external {
    if (msg.sender != COORDINATOR) revert OnlyCoordinatorCanFulfill(msg.sender, COORDINATOR);
    fulfillRandomWords(requestId, randomWords);
  }
}
