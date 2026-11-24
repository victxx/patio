// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Open public directory for Patio streams, v2 (10 Nov 2026 audit).
/// Media never enters this contract. Anyone may announce, as in v1, with two
/// changes:
/// - A stream belongs to (operator, streamId), so nobody can squat or
///   front-run another operator's stream id.
/// - The session wallet signs each announcement, so an operator can only list
///   a session that agreed to be listed under it. Listeners can trust the
///   operator a v2 entry names for a session.
/// Same events as v1, so directory clients decode both.
contract PatioOpenRegistryV2 {
    uint64 public constant MAX_ANNOUNCEMENT_LIFETIME = 1 days;
    /// secp256k1 n / 2: signatures with a higher s are malleable copies.
    uint256 private constant HALF_ORDER =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;
    address public immutable owner;

    mapping(address operator => mapping(bytes16 streamId => bool live))
        public liveStreams;
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
    error InvalidSessionSignature();
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

    /// @notice What the session signs (EIP-191 personal message of these 32
    /// bytes): this registry, chain, operator, stream and session terms.
    function announcementDigest(
        address operator,
        bytes16 streamId,
        address session,
        uint64 nonceStart,
        uint8 mediaMode
    ) public view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    "PatioAnnounce/v2",
                    block.chainid,
                    address(this),
                    operator,
                    streamId,
                    session,
                    nonceStart,
                    mediaMode
                )
            );
    }

    function announce(
        bytes16 streamId,
        address session,
        uint64 nonceStart,
        uint64 expiresAt,
        uint8 mediaMode,
        bytes calldata sessionSignature
    ) external {
        if (blockedOperators[msg.sender]) revert Unauthorized();
        if (
            streamId == bytes16(0) ||
            session == address(0) ||
            expiresAt <= block.timestamp ||
            expiresAt > block.timestamp + MAX_ANNOUNCEMENT_LIFETIME ||
            mediaMode > 1
        ) revert InvalidAnnouncement();
        bytes32 digest = announcementDigest(
            msg.sender,
            streamId,
            session,
            nonceStart,
            mediaMode
        );
        if (_recover(digest, sessionSignature) != session) {
            revert InvalidSessionSignature();
        }
        liveStreams[msg.sender][streamId] = true;
        emit BroadcastAnnounced(
            streamId,
            msg.sender,
            session,
            nonceStart,
            expiresAt,
            mediaMode
        );
    }

    /// @notice The stream's operator ends it.
    function end(bytes16 streamId) external {
        if (!liveStreams[msg.sender][streamId]) revert NotStreamOperator();
        delete liveStreams[msg.sender][streamId];
        emit BroadcastEnded(streamId, msg.sender);
    }

    /// @notice The owner may retire any operator's stream.
    function retire(address operator, bytes16 streamId) external {
        if (msg.sender != owner) revert Unauthorized();
        if (!liveStreams[operator][streamId]) revert NotStreamOperator();
        delete liveStreams[operator][streamId];
        emit BroadcastEnded(streamId, operator);
    }

    function _recover(
        bytes32 digest,
        bytes calldata signature
    ) private pure returns (address) {
        if (signature.length != 65) return address(0);
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        if (v < 27) v += 27;
        if ((v != 27 && v != 28) || uint256(s) > HALF_ORDER) return address(0);
        bytes32 message = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", digest)
        );
        return ecrecover(message, v, r, s);
    }
}
