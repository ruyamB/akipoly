// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title ArcVRFClient
 * @notice The request shape of the hosted Arc VRF (https://arcvrf.007575.xyz),
 * copied from HimanshuM685/arc-vrf contracts/src/libraries/ArcVRFClient.sol
 * (MIT), which itself follows Chainlink's VRFV2PlusClient.
 */
library ArcVRFClient {
  bytes4 public constant EXTRA_ARGS_V1_TAG = bytes4(keccak256("VRF ExtraArgsV1"));

  struct ExtraArgsV1 {
    bool nativePayment;
  }

  struct RandomWordsRequest {
    bytes32 keyHash;
    uint256 subId;
    uint16 requestConfirmations;
    uint32 callbackGasLimit;
    uint32 numWords;
    bytes extraArgs;
  }

  function _argsToBytes(ExtraArgsV1 memory extraArgs) internal pure returns (bytes memory bts) {
    return abi.encodeWithSelector(EXTRA_ARGS_V1_TAG, extraArgs);
  }

  /// @notice Pay in Arc's native USDC (the only payment the Arc VRF accepts).
  function nativeExtraArgs() internal pure returns (bytes memory) {
    return _argsToBytes(ExtraArgsV1({nativePayment: true}));
  }
}

/// @notice The part of the Arc VRF coordinator Akipoly uses.
interface IArcVRFCoordinator {
  function requestRandomWords(ArcVRFClient.RandomWordsRequest calldata req) external returns (uint256 requestId);
}
