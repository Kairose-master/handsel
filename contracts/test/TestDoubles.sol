// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal ERC-20 for exercising LaborMarketV2 in a local EVM.
/// @dev    Deliberately NOT a copy of MockUSDC: this exists only so the escrow
///         has something to move, and it returns `true` on success like the
///         real token so the market's `require(transfer(...))` checks are
///         meaningfully exercised.
contract TestUSDC {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "balance");
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @notice Settable credit registry, so score gating can be driven from a test.
contract TestRegistry {
    mapping(address => uint256) private scores;

    function setScore(address agent, uint256 score) external {
        scores[agent] = score;
    }

    function creditScore(address agent) external view returns (uint256) {
        return scores[agent];
    }
}
