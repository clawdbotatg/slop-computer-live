//SPDX-License-Identifier: MIT
pragma solidity >=0.8.0 <0.9.0;

/**
 * Voting Booth poll anchor. After a private poll's reveal ceremony, the
 * relay posts the result here so the outcome is permanently verifiable
 * on-chain. Ballots themselves never touch the chain — they are
 * threshold-BFV ciphertexts held off-chain; `ballotsRoot` commits to
 * them (keccak256 of the concatenated keccak256 of each ciphertext, in
 * ballot order) so anyone holding the ciphertext set can check that the
 * anchored tally corresponds to exactly those ballots.
 *
 * Deliberately permissionless and stateless: one event, no storage, no
 * owner. Trust in the tally is social (the poster), the same phase-1
 * trust model the app discloses — the anchor makes the claim immutable,
 * not proven. A production version is an Interfold E3 with a verified
 * RISC Zero tally proof.
 */
contract PollAnchor {
    event PollAnchored(
        bytes32 indexed pollId,
        address indexed poster,
        string question,
        string[] options,
        uint256[] tally,
        uint256 ballotCount,
        bytes32 ballotsRoot
    );

    function anchor(
        bytes32 pollId,
        string calldata question,
        string[] calldata options,
        uint256[] calldata tally,
        uint256 ballotCount,
        bytes32 ballotsRoot
    ) external {
        require(tally.length == options.length, "tally/options length mismatch");
        emit PollAnchored(pollId, msg.sender, question, options, tally, ballotCount, ballotsRoot);
    }
}
