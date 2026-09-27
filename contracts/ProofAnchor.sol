// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title ProofAnchor
 * @notice One Merkle root per epoch over the work proofs Handsel issued in
 *         that epoch. The proofs themselves stay off-chain (EIP-712-signed,
 *         gas-free); this contract makes their existence and their set
 *         tamper-evident from the chain alone: a proof + inclusion path
 *         verifies against `roots[epoch]` with no Handsel API in the loop.
 *
 *         Deliberately minimal — no upgrade path, no pause, no owner beyond
 *         the single anchoring key, no reading of the proofs. Epochs are
 *         strictly increasing and write-once, so a root can never be
 *         replaced: correcting a batch means anchoring a new epoch that
 *         says so, which is itself on the record.
 */
contract ProofAnchor {
    /// @notice The only key allowed to anchor (the Handsel attestation oracle).
    address public immutable anchorer;

    /// @notice epoch → Merkle root of that epoch's proof leaves.
    mapping(uint64 => bytes32) public roots;
    /// @notice epoch → number of leaves under the root (informational).
    mapping(uint64 => uint32) public counts;
    /// @notice Highest epoch anchored so far (0 = none).
    uint64 public latestEpoch;

    event Anchored(uint64 indexed epoch, bytes32 root, uint32 count, uint64 fromTs, uint64 toTs);

    error NotAnchorer();
    error EpochNotIncreasing(uint64 latest, uint64 given);
    error EmptyRoot();

    constructor(address anchorer_) {
        require(anchorer_ != address(0), "anchorer");
        anchorer = anchorer_;
    }

    /**
     * @param epoch   Strictly greater than `latestEpoch`. Unix hour is the
     *                convention off-chain, but any increasing id works.
     * @param root    Merkle root (sorted-pair keccak256, OpenZeppelin style).
     * @param count   Leaves under the root.
     * @param fromTs  Issued-at of the earliest proof in the batch (unix s).
     * @param toTs    Issued-at of the latest proof in the batch (unix s).
     */
    function anchor(uint64 epoch, bytes32 root, uint32 count, uint64 fromTs, uint64 toTs) external {
        if (msg.sender != anchorer) revert NotAnchorer();
        if (epoch <= latestEpoch) revert EpochNotIncreasing(latestEpoch, epoch);
        if (root == bytes32(0)) revert EmptyRoot();
        roots[epoch] = root;
        counts[epoch] = count;
        latestEpoch = epoch;
        emit Anchored(epoch, root, count, fromTs, toTs);
    }

    /**
     * @notice Pure inclusion check, so a verifier with only an RPC can ask
     *         the contract itself. Same algorithm as lib/proof-merkle.ts.
     */
    function verify(uint64 epoch, bytes32 leaf, bytes32[] calldata path) external view returns (bool) {
        bytes32 root = roots[epoch];
        if (root == bytes32(0)) return false;
        bytes32 acc = leaf;
        for (uint256 i = 0; i < path.length; i++) {
            bytes32 s = path[i];
            acc = acc < s ? keccak256(abi.encodePacked(acc, s)) : keccak256(abi.encodePacked(s, acc));
        }
        return acc == root;
    }
}
