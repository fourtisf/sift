// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {SiftVaultFactory} from "../src/SiftVaultFactory.sol";

/// forge script script/Deploy.s.sol --rpc-url $RPC_HTTP --private-key $DEPLOYER_KEY --broadcast
/// Then allowlist the Pons curve code hash (see README):
/// cast send $FACTORY "setCurveCode(bytes32,bool)" $(cast codehash <any-pons-curve> --rpc-url $RPC_HTTP) true
contract Deploy is Script {
    // Robinhood Chain mainnet (chain id 4663)
    address constant UNIVERSAL_ROUTER = 0x06AfBA43Fd06227fA663b0DAecF536f6EaA6bf99;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant PONS_V2_HOOK = 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044;
    uint24 constant POOL_FEE = 0;
    int24 constant TICK_SPACING = 200;

    function run() external {
        vm.startBroadcast();
        SiftVaultFactory f = new SiftVaultFactory(UNIVERSAL_ROUTER, PERMIT2, PONS_V2_HOOK, POOL_FEE, TICK_SPACING);
        vm.stopBroadcast();
        console2.log("SiftVaultFactory", address(f));
    }
}
