// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {SiftVault} from "./SiftVault.sol";

/*
    SiftVaultFactory
    ----------------
    Deploys one SiftVault per owner and holds the chain-wide settings every vault reads:
    Uniswap Universal Router, Permit2, the Pons v4 hook and pool parameters, and the
    allowlist of Pons bonding-curve runtime code hashes.

    The admin can only change these shared settings. The admin can never move funds
    out of any vault.
*/
contract SiftVaultFactory {
    address public admin;
    address public pendingAdmin;

    address public universalRouter;
    address public permit2;
    address public ponsHook;
    uint24 public poolFee;
    int24 public poolTickSpacing;

    mapping(bytes32 => bool) public allowedCurveCode;
    mapping(address => address) public vaultOf;

    event VaultCreated(address indexed owner, address vault, address agent);
    event CurveCodeSet(bytes32 indexed codehash, bool allowed);
    event SettingsChanged(address router, address permit2, address hook, uint24 fee, int24 tickSpacing);
    event AdminProposed(address admin);
    event AdminAccepted(address admin);

    error NotAdmin();
    error VaultExists();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(address router_, address permit2_, address hook_, uint24 fee_, int24 tickSpacing_) {
        admin = msg.sender;
        _setSettings(router_, permit2_, hook_, fee_, tickSpacing_);
    }

    function createVault(address agent, uint256 maxPerTrade, uint256 dailyCap) external returns (address vault) {
        if (vaultOf[msg.sender] != address(0)) revert VaultExists();
        vault = address(new SiftVault{salt: bytes32(uint256(uint160(msg.sender)))}(msg.sender, agent, maxPerTrade, dailyCap));
        vaultOf[msg.sender] = vault;
        emit VaultCreated(msg.sender, vault, agent);
    }

    function isCurveCodeAllowed(bytes32 codehash) external view returns (bool) {
        return allowedCurveCode[codehash];
    }

    function setCurveCode(bytes32 codehash, bool allowed) external onlyAdmin {
        allowedCurveCode[codehash] = allowed;
        emit CurveCodeSet(codehash, allowed);
    }

    function setSettings(address router_, address permit2_, address hook_, uint24 fee_, int24 tickSpacing_)
        external
        onlyAdmin
    {
        _setSettings(router_, permit2_, hook_, fee_, tickSpacing_);
    }

    function proposeAdmin(address next) external onlyAdmin {
        pendingAdmin = next;
        emit AdminProposed(next);
    }

    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert NotAdmin();
        admin = pendingAdmin;
        pendingAdmin = address(0);
        emit AdminAccepted(admin);
    }

    function _setSettings(address router_, address permit2_, address hook_, uint24 fee_, int24 tickSpacing_) internal {
        universalRouter = router_;
        permit2 = permit2_;
        ponsHook = hook_;
        poolFee = fee_;
        poolTickSpacing = tickSpacing_;
        emit SettingsChanged(router_, permit2_, hook_, fee_, tickSpacing_);
    }
}
