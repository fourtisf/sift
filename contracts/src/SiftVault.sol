// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/*
    SiftVault
    ---------
    A per-user trading vault for Pons tokens on Robinhood Chain.

    - The OWNER (the user's wallet) owns every asset in the vault and is the only
      address that can withdraw, change limits or change the agent.
    - The AGENT (the Sift server key) can only:
        * buy / sell on a Pons bonding curve whose runtime code hash is allowlisted
          by the factory admin, and
        * buy / sell a Pons token against ETH in its graduated Uniswap v4 pool
          (pool key fixed to the Pons hook, so the agent cannot pick the pool).
      Every buy is capped per trade and per 24h window. Proceeds always land back
      in the vault. The agent can never send ETH or tokens anywhere else.
    - Either party can pause. Only the owner can unpause.
*/

interface IPonsCurve {
    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) external payable returns (uint256);
    function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) external returns (uint256);
}

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
}

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface ISiftVaultFactory {
    function isCurveCodeAllowed(bytes32 codehash) external view returns (bool);
    function universalRouter() external view returns (address);
    function permit2() external view returns (address);
    function ponsHook() external view returns (address);
    function poolFee() external view returns (uint24);
    function poolTickSpacing() external view returns (int24);
}

contract SiftVault {
    // ---- Uniswap v4 types (v4-periphery IV4Router) ----
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    struct ExactInputSingleParams {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        bytes hookData;
    }

    // Universal Router command and v4 action ids
    uint8 internal constant CMD_V4_SWAP = 0x10;
    uint8 internal constant ACT_SWAP_EXACT_IN_SINGLE = 0x06;
    uint8 internal constant ACT_SETTLE_ALL = 0x0c;
    uint8 internal constant ACT_TAKE_ALL = 0x0f;

    ISiftVaultFactory public immutable factory;
    address public immutable owner;

    address public agent;
    uint256 public maxPerTrade; // wei
    uint256 public dailyCap; // wei
    uint256 public spentInWindow; // wei
    uint256 public windowStart; // timestamp
    bool public paused;
    bool public curveTradingEnabled = true;

    uint256 private _lock = 1;

    event AgentChanged(address indexed agent);
    event LimitsChanged(uint256 maxPerTrade, uint256 dailyCap);
    event Paused(address indexed by);
    event Unpaused();
    event CurveTradingSet(bool enabled);
    event Bought(address indexed token, address indexed venue, uint256 ethIn, uint256 tokensOut);
    event Sold(address indexed token, address indexed venue, uint256 tokensIn, uint256 ethOut);
    event Withdrawn(address indexed asset, uint256 amount);

    error NotOwner();
    error NotAgent();
    error IsPaused();
    error OverTradeLimit();
    error OverDailyLimit();
    error CurveNotAllowed();
    error SlippageTooHigh();
    error Reentrant();
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyAgent() {
        if (msg.sender != agent) revert NotAgent();
        if (paused) revert IsPaused();
        _;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrant();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address owner_, address agent_, uint256 maxPerTrade_, uint256 dailyCap_) {
        factory = ISiftVaultFactory(msg.sender);
        owner = owner_;
        agent = agent_;
        maxPerTrade = maxPerTrade_;
        dailyCap = dailyCap_;
        windowStart = block.timestamp;
        emit AgentChanged(agent_);
        emit LimitsChanged(maxPerTrade_, dailyCap_);
    }

    receive() external payable {}

    // ------------------------------------------------------------------
    // Agent: trading
    // ------------------------------------------------------------------

    function buyOnCurve(address curve, uint256 ethIn, uint256 minTokensOut, address token)
        external
        onlyAgent
        nonReentrant
        returns (uint256 tokensOut)
    {
        _checkCurve(curve);
        _spend(ethIn);
        uint256 before = IERC20(token).balanceOf(address(this));
        IPonsCurve(curve).buy{value: ethIn}(ethIn, minTokensOut, address(this));
        tokensOut = IERC20(token).balanceOf(address(this)) - before;
        if (tokensOut < minTokensOut) revert SlippageTooHigh();
        emit Bought(token, curve, ethIn, tokensOut);
    }

    function sellOnCurve(address curve, address token, uint256 tokensIn, uint256 minEthOut)
        external
        onlyAgent
        nonReentrant
        returns (uint256 ethOut)
    {
        _checkCurve(curve);
        uint256 before = address(this).balance;
        _approve(token, curve, tokensIn);
        IPonsCurve(curve).sell(tokensIn, minEthOut, address(this));
        _approve(token, curve, 0);
        ethOut = address(this).balance - before;
        if (ethOut < minEthOut) revert SlippageTooHigh();
        emit Sold(token, curve, tokensIn, ethOut);
    }

    function buyOnPool(address token, uint256 ethIn, uint256 minTokensOut, uint256 deadline)
        external
        onlyAgent
        nonReentrant
        returns (uint256 tokensOut)
    {
        _spend(ethIn);
        uint256 before = IERC20(token).balanceOf(address(this));
        _v4Swap(token, true, ethIn, minTokensOut, deadline, ethIn);
        tokensOut = IERC20(token).balanceOf(address(this)) - before;
        if (tokensOut < minTokensOut) revert SlippageTooHigh();
        emit Bought(token, factory.universalRouter(), ethIn, tokensOut);
    }

    function sellOnPool(address token, uint256 tokensIn, uint256 minEthOut, uint256 deadline)
        external
        onlyAgent
        nonReentrant
        returns (uint256 ethOut)
    {
        address p2 = factory.permit2();
        address router = factory.universalRouter();
        _approve(token, p2, tokensIn);
        IPermit2(p2).approve(token, router, uint160(tokensIn), uint48(block.timestamp + 300));
        uint256 before = address(this).balance;
        _v4Swap(token, false, tokensIn, minEthOut, deadline, 0);
        IPermit2(p2).approve(token, router, 0, 0);
        _approve(token, p2, 0);
        ethOut = address(this).balance - before;
        if (ethOut < minEthOut) revert SlippageTooHigh();
        emit Sold(token, router, tokensIn, ethOut);
    }

    function pause() external {
        if (msg.sender != owner && msg.sender != agent) revert NotAgent();
        paused = true;
        emit Paused(msg.sender);
    }

    // ------------------------------------------------------------------
    // Owner
    // ------------------------------------------------------------------

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused();
    }

    function setAgent(address agent_) external onlyOwner {
        agent = agent_;
        emit AgentChanged(agent_);
    }

    function setLimits(uint256 maxPerTrade_, uint256 dailyCap_) external onlyOwner {
        maxPerTrade = maxPerTrade_;
        dailyCap = dailyCap_;
        emit LimitsChanged(maxPerTrade_, dailyCap_);
    }

    function setCurveTrading(bool enabled) external onlyOwner {
        curveTradingEnabled = enabled;
        emit CurveTradingSet(enabled);
    }

    function withdrawETH(uint256 amount) external onlyOwner nonReentrant {
        (bool ok,) = owner.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(address(0), amount);
    }

    function withdrawToken(address token, uint256 amount) external onlyOwner nonReentrant {
        if (!IERC20(token).transfer(owner, amount)) revert TransferFailed();
        emit Withdrawn(token, amount);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function remainingToday() public view returns (uint256) {
        if (block.timestamp >= windowStart + 1 days) return dailyCap;
        return spentInWindow >= dailyCap ? 0 : dailyCap - spentInWindow;
    }

    // ------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------

    function _checkCurve(address curve) internal view {
        if (!curveTradingEnabled) revert CurveNotAllowed();
        if (!factory.isCurveCodeAllowed(curve.codehash)) revert CurveNotAllowed();
    }

    function _spend(uint256 amount) internal {
        if (amount > maxPerTrade) revert OverTradeLimit();
        if (block.timestamp >= windowStart + 1 days) {
            windowStart = block.timestamp;
            spentInWindow = 0;
        }
        if (spentInWindow + amount > dailyCap) revert OverDailyLimit();
        spentInWindow += amount;
    }

    function _approve(address token, address spender, uint256 amount) internal {
        // Some tokens require resetting to zero first; Pons tokens are standard ERC20.
        if (!IERC20(token).approve(spender, amount)) revert TransferFailed();
    }

    function _v4Swap(address token, bool ethToToken, uint256 amountIn, uint256 minOut, uint256 deadline, uint256 value)
        internal
    {
        PoolKey memory key = PoolKey({
            currency0: address(0), // native ETH always sorts first
            currency1: token,
            fee: factory.poolFee(),
            tickSpacing: factory.poolTickSpacing(),
            hooks: factory.ponsHook()
        });
        address inC = ethToToken ? address(0) : token;
        address outC = ethToToken ? token : address(0);

        bytes memory actions = abi.encodePacked(ACT_SWAP_EXACT_IN_SINGLE, ACT_SETTLE_ALL, ACT_TAKE_ALL);
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            ExactInputSingleParams({
                poolKey: key,
                zeroForOne: ethToToken,
                amountIn: uint128(amountIn),
                amountOutMinimum: uint128(minOut),
                hookData: bytes("")
            })
        );
        params[1] = abi.encode(inC, amountIn);
        params[2] = abi.encode(outC, minOut);

        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);
        IUniversalRouter(factory.universalRouter()).execute{value: value}(abi.encodePacked(CMD_V4_SWAP), inputs, deadline);
    }
}
