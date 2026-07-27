// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * MiniVault — the GIWA MiniDAI flow as ONE compact contract:
 *
 *   ETH collateral → gUSD stable debt → owner-fed price oracle (mock) →
 *   health factor → close-factor liquidation with a seizure bonus.
 *
 * It intentionally mirrors lib/mini-vault.ts (the pure TS engine) parameter
 * for parameter — MCR 150%, liquidation ratio 120%, close factor 50%,
 * bonus 10% — so every on-chain number can be cross-checked against the
 * unit-tested engine. Testnet teaching vault: the oracle price is owner-set
 * (the lab's Oracle Mock), NOT a production price feed.
 *
 * Units:
 *   price     gUSD-wei per 1 ETH (1e18-scaled USD/ETH)
 *   valueUsd  collateralWei * price / 1e18   (gUSD-wei)
 *   HF        1e18 fixed point; < 1e18 → liquidatable
 */
contract MiniVault {
    // ── minimal ERC20 (gUSD) ────────────────────────────────────────────
    string public constant name = "Handsel Stable (test)";
    string public constant symbol = "gUSD";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= value, "allowance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - value;
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) internal {
        require(balanceOf[from] >= value, "balance");
        unchecked {
            balanceOf[from] -= value;
            balanceOf[to] += value;
        }
        emit Transfer(from, to, value);
    }

    function _mint(address to, uint256 value) internal {
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }

    function _burn(address from, uint256 value) internal {
        require(balanceOf[from] >= value, "balance");
        unchecked {
            balanceOf[from] -= value;
            totalSupply -= value;
        }
        emit Transfer(from, address(0), value);
    }

    // ── vault params (bps) — MUST match lib/mini-vault.ts DEFAULT_VAULT ─
    uint256 public constant MCR_BPS = 15000; // 150% to mint
    uint256 public constant LIQ_BPS = 12000; // 120% liquidation ratio
    uint256 public constant CLOSE_FACTOR_BPS = 5000; // repay ≤ 50% of debt
    uint256 public constant BONUS_BPS = 1000; // 10% seizure bonus
    uint256 private constant BPS = 10000;
    uint256 private constant WAD = 1e18;

    address public owner; // the platform oracle — feeds the mock price
    uint256 public price; // gUSD-wei per ETH

    struct Position {
        uint256 collateral; // wei
        uint256 debt; // gUSD-wei
    }

    mapping(address => Position) public positions;
    bool private locked;

    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event Minted(address indexed user, uint256 amount);
    event Repaid(address indexed user, uint256 amount);
    event Liquidated(address indexed user, address indexed liquidator, uint256 repaid, uint256 seized);
    event PriceUpdated(uint256 price);

    modifier nonReentrant() {
        require(!locked, "reentrant");
        locked = true;
        _;
        locked = false;
    }

    constructor(uint256 initialPrice) {
        require(initialPrice > 0, "price");
        owner = msg.sender;
        price = initialPrice;
        emit PriceUpdated(initialPrice);
    }

    /** Oracle Mock: only the platform oracle moves the price. */
    function setPrice(uint256 newPrice) external {
        require(msg.sender == owner, "owner");
        require(newPrice > 0, "price");
        price = newPrice;
        emit PriceUpdated(newPrice);
    }

    // ── views (mirror the TS engine) ────────────────────────────────────
    function collateralValueUsd(address user) public view returns (uint256) {
        return (positions[user].collateral * price) / WAD;
    }

    function maxDebtUsd(address user) public view returns (uint256) {
        return (collateralValueUsd(user) * BPS) / MCR_BPS;
    }

    /** 1e18 fixed point; type(uint256).max when debt-free. */
    function healthFactor(address user) public view returns (uint256) {
        Position memory p = positions[user];
        if (p.debt == 0) return type(uint256).max;
        return (collateralValueUsd(user) * BPS * WAD) / (p.debt * LIQ_BPS);
    }

    function isLiquidatable(address user) public view returns (bool) {
        return healthFactor(user) < WAD;
    }

    // ── actions ─────────────────────────────────────────────────────────
    function deposit() external payable {
        require(msg.value > 0, "amount");
        positions[msg.sender].collateral += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    /** Withdraw collateral — remaining debt must stay under the MINT gate,
     *  so a withdrawal can never push you straight into liquidation. */
    function withdraw(uint256 amount) external nonReentrant {
        Position storage p = positions[msg.sender];
        require(amount > 0 && amount <= p.collateral, "amount");
        p.collateral -= amount;
        require(p.debt <= maxDebtUsd(msg.sender), "would undercollateralize");
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "eth send");
        emit Withdrawn(msg.sender, amount);
    }

    /** Mint gate: total debt ≤ collateralValue / MCR. */
    function mint(uint256 amount) external {
        require(amount > 0, "amount");
        Position storage p = positions[msg.sender];
        p.debt += amount;
        require(p.debt <= maxDebtUsd(msg.sender), "exceeds MCR");
        _mint(msg.sender, amount);
        emit Minted(msg.sender, amount);
    }

    function repay(uint256 amount) external {
        Position storage p = positions[msg.sender];
        require(amount > 0 && amount <= p.debt, "amount");
        _burn(msg.sender, amount);
        p.debt -= amount;
        emit Repaid(msg.sender, amount);
    }

    /**
     * Liquidation: only when HF < 1. Repay is capped at closeFactor × debt;
     * the liquidator burns their own gUSD and seizes collateral worth
     * repaid × (1 + bonus), capped by the position's balance.
     */
    function liquidate(address user, uint256 repayAmount) external nonReentrant {
        require(isLiquidatable(user), "healthy");
        Position storage p = positions[user];
        uint256 maxRepay = (p.debt * CLOSE_FACTOR_BPS) / BPS;
        uint256 repaid = repayAmount > maxRepay ? maxRepay : repayAmount;
        require(repaid > 0, "amount");

        uint256 seize = (repaid * (BPS + BONUS_BPS) * WAD) / (BPS * price);
        if (seize > p.collateral) seize = p.collateral;

        _burn(msg.sender, repaid);
        p.debt -= repaid;
        p.collateral -= seize;

        (bool ok, ) = msg.sender.call{value: seize}("");
        require(ok, "eth send");
        emit Liquidated(user, msg.sender, repaid, seize);
    }
}
