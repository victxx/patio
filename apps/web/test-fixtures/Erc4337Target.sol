// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @dev Local-test-only target used to verify EntryPoint v0.7 execution.
contract Erc4337Target {
    uint256 public value;

    function setValue(uint256 nextValue) external {
        value = nextValue;
    }

    function fail() external pure {
        revert("fixture revert");
    }
}
