// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {ERC8004IdentityRegistry, ERC8004ReputationRegistry, ERC8004ValidationRegistry} from "../src/ERC8004Registries.sol";

/// @notice Deploys the three ERC-8004 registries. Chain-agnostic — works on
///         Sepolia and GIWA Sepolia alike (GIWA has no ERC-8004 deployment
///         yet, so this makes Handsel the first there).
///
/// Usage:
///   forge script script/DeployERC8004.s.sol \
///     --rpc-url giwa_sepolia --broadcast \
///     --private-key $DEPLOYER_PRIVATE_KEY \
///     --verify --verifier blockscout \
///     --verifier-url https://sepolia-explorer.giwa.io/api
contract DeployERC8004 is Script {
    function run() external {
        vm.startBroadcast();

        ERC8004IdentityRegistry identity = new ERC8004IdentityRegistry();
        ERC8004ReputationRegistry reputation = new ERC8004ReputationRegistry(address(identity));
        ERC8004ValidationRegistry validation = new ERC8004ValidationRegistry(address(identity));

        vm.stopBroadcast();

        console.log("ERC8004IdentityRegistry:   ", address(identity));
        console.log("ERC8004ReputationRegistry: ", address(reputation));
        console.log("ERC8004ValidationRegistry: ", address(validation));
    }
}
