// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {SiftVault} from "../src/SiftVault.sol";
import {SiftVaultFactory} from "../src/SiftVaultFactory.sol";

contract MockToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }

    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        allowance[f][msg.sender] -= a;
        balanceOf[f] -= a;
        balanceOf[to] += a;
        return true;
    }
}

/// Simplified Pons curve: 1 wei of ETH buys 1000 token units, sells back at the same rate.
contract MockCurve {
    MockToken public token;

    constructor(MockToken t) payable {
        token = t;
    }

    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) external payable returns (uint256 out) {
        require(msg.value == quoteIn, "value");
        out = quoteIn * 1000;
        require(out >= minTokensOut, "min");
        token.mint(recipient, out);
    }

    function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) external returns (uint256 out) {
        token.transferFrom(msg.sender, address(this), tokensIn);
        out = tokensIn / 1000;
        require(out >= minQuoteOut, "min");
        payable(recipient).transfer(out);
    }

    receive() external payable {}
}

/// A curve with different code, standing in for a malicious contract.
contract EvilCurve {
    function buy(uint256, uint256, address) external payable returns (uint256) {
        return 0;
    }
}

contract MockPermit2 {
    mapping(address => mapping(address => mapping(address => uint160))) public allowed;

    function approve(address token, address spender, uint160 amount, uint48) external {
        allowed[msg.sender][token][spender] = amount;
    }

    function pull(address token, address from, address to, uint160 amount) external {
        require(allowed[from][token][msg.sender] >= amount, "permit2");
        allowed[from][token][msg.sender] -= amount;
        MockToken(token).transferFrom(from, to, amount);
    }
}

/// Decodes the exact V4_SWAP payload the vault builds and settles it at a fixed rate.
contract MockUniversalRouter {
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

    MockPermit2 public permit2;
    address public lastHook;
    uint24 public lastFee;
    int24 public lastTickSpacing;

    constructor(MockPermit2 p) payable {
        permit2 = p;
    }

    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable {
        require(block.timestamp <= deadline, "deadline");
        require(commands.length == 1 && uint8(commands[0]) == 0x10, "cmd");
        (bytes memory actions, bytes[] memory params) = abi.decode(inputs[0], (bytes, bytes[]));
        require(actions.length == 3 && uint8(actions[0]) == 0x06 && uint8(actions[1]) == 0x0c && uint8(actions[2]) == 0x0f, "actions");
        ExactInputSingleParams memory p = abi.decode(params[0], (ExactInputSingleParams));
        lastHook = p.poolKey.hooks;
        lastFee = p.poolKey.fee;
        lastTickSpacing = p.poolKey.tickSpacing;
        require(p.poolKey.currency0 == address(0), "currency0");
        MockToken token = MockToken(p.poolKey.currency1);
        if (p.zeroForOne) {
            require(msg.value == p.amountIn, "value");
            uint256 out = uint256(p.amountIn) * 2000;
            require(out >= p.amountOutMinimum, "min");
            token.mint(msg.sender, out);
        } else {
            permit2.pull(address(token), msg.sender, address(this), p.amountIn);
            uint256 out = uint256(p.amountIn) / 2000;
            require(out >= p.amountOutMinimum, "min");
            payable(msg.sender).transfer(out);
        }
    }

    receive() external payable {}
}

contract SiftVaultTest is Test {
    SiftVaultFactory factory;
    SiftVault vault;
    MockToken token;
    MockCurve curve;
    MockPermit2 permit2;
    MockUniversalRouter router;

    address owner = address(0xA11CE);
    address agent = address(0xB0B);
    address hook = address(0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044);

    function setUp() public {
        token = new MockToken();
        curve = new MockCurve{value: 100 ether}(token);
        permit2 = new MockPermit2();
        router = new MockUniversalRouter{value: 100 ether}(permit2);
        factory = new SiftVaultFactory(address(router), address(permit2), hook, 0, 200);
        factory.setCurveCode(address(curve).codehash, true);

        vm.prank(owner);
        vault = SiftVault(payable(factory.createVault(agent, 0.1 ether, 0.25 ether)));
        vm.deal(address(vault), 1 ether);
    }

    function test_factoryRecordsVault() public view {
        assertEq(factory.vaultOf(owner), address(vault));
        assertEq(vault.owner(), owner);
        assertEq(vault.agent(), agent);
    }

    function test_cannotCreateTwoVaults() public {
        vm.prank(owner);
        vm.expectRevert(SiftVaultFactory.VaultExists.selector);
        factory.createVault(agent, 1, 1);
    }

    function test_agentBuysAndSellsOnCurve() public {
        vm.prank(agent);
        uint256 got = vault.buyOnCurve(address(curve), 0.05 ether, 1, address(token));
        assertEq(got, 0.05 ether * 1000);
        assertEq(token.balanceOf(address(vault)), got);
        assertEq(address(vault).balance, 0.95 ether);

        vm.prank(agent);
        uint256 back = vault.sellOnCurve(address(curve), address(token), got, 1);
        assertEq(back, 0.05 ether);
        assertEq(address(vault).balance, 1 ether);
        assertEq(token.balanceOf(address(vault)), 0);
    }

    function test_rejectsUnknownCurveCode() public {
        EvilCurve evil = new EvilCurve();
        vm.prank(agent);
        vm.expectRevert(SiftVault.CurveNotAllowed.selector);
        vault.buyOnCurve(address(evil), 0.01 ether, 0, address(token));
    }

    function test_perTradeLimit() public {
        vm.prank(agent);
        vm.expectRevert(SiftVault.OverTradeLimit.selector);
        vault.buyOnCurve(address(curve), 0.11 ether, 1, address(token));
    }

    function test_dailyLimitAndReset() public {
        vm.startPrank(agent);
        vault.buyOnCurve(address(curve), 0.1 ether, 1, address(token));
        vault.buyOnCurve(address(curve), 0.1 ether, 1, address(token));
        vm.expectRevert(SiftVault.OverDailyLimit.selector);
        vault.buyOnCurve(address(curve), 0.1 ether, 1, address(token));
        vm.warp(block.timestamp + 1 days + 1);
        vault.buyOnCurve(address(curve), 0.1 ether, 1, address(token));
        vm.stopPrank();
        assertEq(vault.spentInWindow(), 0.1 ether);
    }

    function test_onlyAgentCanTrade() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(SiftVault.NotAgent.selector);
        vault.buyOnCurve(address(curve), 0.01 ether, 1, address(token));
    }

    function test_agentCannotWithdraw() public {
        vm.prank(agent);
        vm.expectRevert(SiftVault.NotOwner.selector);
        vault.withdrawETH(1 ether);
    }

    function test_ownerWithdraws() public {
        uint256 before = owner.balance;
        vm.prank(owner);
        vault.withdrawETH(0.4 ether);
        assertEq(owner.balance - before, 0.4 ether);
    }

    function test_pauseBlocksTrading_andOnlyOwnerUnpauses() public {
        vm.prank(agent);
        vault.pause();
        vm.prank(agent);
        vm.expectRevert(SiftVault.IsPaused.selector);
        vault.buyOnCurve(address(curve), 0.01 ether, 1, address(token));
        vm.prank(agent);
        vm.expectRevert(SiftVault.NotOwner.selector);
        vault.unpause();
        vm.prank(owner);
        vault.unpause();
        vm.prank(agent);
        vault.buyOnCurve(address(curve), 0.01 ether, 1, address(token));
    }

    function test_ownerCanRevokeAgent() public {
        vm.prank(owner);
        vault.setAgent(address(0));
        vm.prank(agent);
        vm.expectRevert(SiftVault.NotAgent.selector);
        vault.buyOnCurve(address(curve), 0.01 ether, 1, address(token));
    }

    function test_poolBuyAndSell_usesPonsPoolKey() public {
        vm.prank(agent);
        uint256 got = vault.buyOnPool(address(token), 0.02 ether, 1, block.timestamp + 60);
        assertEq(got, 0.02 ether * 2000);
        assertEq(router.lastHook(), hook);
        assertEq(router.lastFee(), 0);
        assertEq(router.lastTickSpacing(), 200);

        vm.prank(agent);
        uint256 back = vault.sellOnPool(address(token), got, 1, block.timestamp + 60);
        assertEq(back, 0.02 ether);
        assertEq(token.balanceOf(address(vault)), 0);
        assertEq(permit2.allowed(address(vault), address(token), address(router)), 0);
    }

    function test_slippageGuardOnPool() public {
        vm.prank(agent);
        vm.expectRevert(bytes("min"));
        vault.buyOnPool(address(token), 0.01 ether, type(uint128).max, block.timestamp + 60);
    }

    function test_curveTradingCanBeDisabledByOwner() public {
        vm.prank(owner);
        vault.setCurveTrading(false);
        vm.prank(agent);
        vm.expectRevert(SiftVault.CurveNotAllowed.selector);
        vault.buyOnCurve(address(curve), 0.01 ether, 1, address(token));
    }

    function test_adminTransferIsTwoStep() public {
        factory.proposeAdmin(owner);
        assertEq(factory.admin(), address(this));
        vm.prank(owner);
        factory.acceptAdmin();
        assertEq(factory.admin(), owner);
    }
}
