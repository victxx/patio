// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @dev Local-test-only negative fixture. It is not a production paymaster.
contract PostOpRevertingPaymaster {
    struct PackedUserOperation {
        address sender;
        uint256 nonce;
        bytes initCode;
        bytes callData;
        bytes32 accountGasLimits;
        uint256 preVerificationGas;
        bytes32 gasFees;
        bytes paymasterAndData;
        bytes signature;
    }

    address public immutable entryPoint;

    constructor(address anEntryPoint) {
        entryPoint = anEntryPoint;
    }

    function validatePaymasterUserOp(
        PackedUserOperation calldata,
        bytes32,
        uint256
    ) external view returns (bytes memory context, uint256 validationData) {
        require(msg.sender == entryPoint, "entry point only");
        return (hex"01", 0);
    }

    function postOp(uint8, bytes calldata, uint256, uint256) external pure {
        revert("postOp fixture failure");
    }
}
