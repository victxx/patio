// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Open public directory for Patio streams. Media never enters this
/// contract. Anyone may announce. The owner can only block an operator or
/// retire one stream, for extreme cases; it cannot announce for anyone else,
/// move funds or change an announcement. Same events and read functions as
/// PatioRegistry v1, so directory clients read both.
contract PatioOpenRegistry {
    uint64 public constant MAX_ANNOUNCEMENT_LIFETIME = 1 days;
    address public immutable owner;

    mapping(bytes16 streamId => address operator) public streamOperators;
    mapping(address operator => bool blocked) public blockedOperators;

    event BroadcastAnnounced(
        bytes16 indexed streamId,
        address indexed operator,
        address indexed session,
        uint64 nonceStart,
        uint64 expiresAt,
        uint8 mediaMode
    );
    event BroadcastEnded(bytes16 indexed streamId, address indexed operator);
    event OperatorApprovalChanged(address indexed operator, bool approved);

    error InvalidAnnouncement();
    error NotStreamOperator();
    error Unauthorized();

    constructor(address initialOwner) {
        if (initialOwner == address(0)) revert InvalidAnnouncement();
        owner = initialOwner;
    }

    /// @notice v1-compatible view: every operator is approved unless blocked.
    function approvedOperators(address operator) external view returns (bool) {
        return !blockedOperators[operator];
    }

    /// @notice Extreme cases only. Blocking also tells directory clients to
    /// hide that operator's live announcements.
    function setOperator(address operator, bool approved) external {
        if (msg.sender != owner) revert Unauthorized();
        if (operator == address(0)) revert InvalidAnnouncement();
        blockedOperators[operator] = !approved;
        emit OperatorApprovalChanged(operator, approved);
    }

    function announce(
        bytes16 streamId,
        address session,
        uint64 nonceStart,
        uint64 expiresAt,
        uint8 mediaMode
    ) external {
        if (blockedOperators[msg.sender]) revert Unauthorized();
        if (
            streamId == bytes16(0) ||
            session == address(0) ||
            expiresAt <= block.timestamp ||
            expiresAt > block.timestamp + MAX_ANNOUNCEMENT_LIFETIME ||
            mediaMode > 1
        ) revert InvalidAnnouncement();

        address currentOperator = streamOperators[streamId];
        if (currentOperator != address(0) && currentOperator != msg.sender) {
            revert NotStreamOperator();
        }

        streamOperators[streamId] = msg.sender;
        emit BroadcastAnnounced(
            streamId,
            msg.sender,
            session,
            nonceStart,
            expiresAt,
            mediaMode
        );
    }

    /// @notice The stream's operator ends it; the owner may retire it.
    function end(bytes16 streamId) external {
        address operator = streamOperators[streamId];
        if (operator == address(0)) revert NotStreamOperator();
        if (operator != msg.sender && msg.sender != owner) {
            revert NotStreamOperator();
        }
        delete streamOperators[streamId];
        emit BroadcastEnded(streamId, operator);
    }
}
