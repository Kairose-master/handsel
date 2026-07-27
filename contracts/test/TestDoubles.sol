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

/// @notice TestUSDC plus Circle's blocklist, which real USDC has and the plain
///         double does not.
/// @dev    Exists to answer one question the other double cannot: what happens
///         to a settlement when ONE recipient's transfer reverts, permanently
///         and outside anyone's control? Base USDC is upgradeable by Circle and
///         enforces `blacklist(address)`; a market that pushes payments has to
///         survive that or admit it does not.
contract BlocklistUSDC {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public blocked;

    function setBlocked(address who, bool value) external {
        blocked[who] = value;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    /// @dev Reverts on BOTH sides, exactly like the real one: a blocked address
    ///      can neither send nor receive.
    function transfer(address to, uint256 amount) external returns (bool) {
        require(!blocked[msg.sender] && !blocked[to], "blocked");
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(!blocked[from] && !blocked[to] && !blocked[msg.sender], "blocked");
        require(balanceOf[from] >= amount, "balance");
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @notice A credit registry that refuses to answer.
/// @dev    `registry` is immutable and `creditScore` is called unguarded inside
///         acceptJob. If the real registry is ever upgraded into something that
///         reverts — or is simply a contract that stops existing — this double
///         says what that does to the market.
contract RevertingRegistry {
    function creditScore(address) external pure returns (uint256) {
        revert("registry down");
    }
}

/// @notice A registry that answers, but burns all the gas doing it.
contract GasBurningRegistry {
    uint256 private sink;

    function creditScore(address) external returns (uint256) {
        // Unbounded: consumes whatever the caller forwarded.
        for (uint256 i = 0; i < type(uint256).max; i++) sink = i;
        return 0;
    }
}
