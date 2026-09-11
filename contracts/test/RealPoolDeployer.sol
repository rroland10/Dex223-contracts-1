// SPDX-License-Identifier: UNLICENSED
pragma solidity =0.7.6;

import '../dex-core/Dex223Pool.sol';
import '../dex-core/interfaces/IDex223PoolDeployer.sol';

/// @dev Deploys the real, unmodified `Dex223Pool`.
///
/// Dex223Factory exceeds the EIP-170 24576-byte runtime limit and therefore cannot be deployed to a live
/// network, so this minimal deployer stands in for it when exercising a genuine `Dex223Pool` on a testnet.
/// `factory` is whatever address is passed in, and `Dex223Pool.set` is gated on `msg.sender == factory`,
/// so passing an EOA lets that EOA configure the pool directly.
contract RealPoolDeployer is IDex223PoolDeployer {
    struct Parameters {
        address factory;
        address token0_erc20;
        address token1_erc20;
        uint24 fee;
        int24 tickSpacing;
    }

    Parameters public override parameters;

    event PoolDeployed(address pool);

    function deploy(
        address factory,
        address token0_erc20,
        address token1_erc20,
        uint24 fee,
        int24 tickSpacing
    ) external returns (address pool) {
        parameters = Parameters({
            factory: factory,
            token0_erc20: token0_erc20,
            token1_erc20: token1_erc20,
            fee: fee,
            tickSpacing: tickSpacing
        });
        pool = address(new Dex223Pool{salt: keccak256(abi.encode(token0_erc20, token1_erc20, fee))}());
        emit PoolDeployed(pool);
        delete parameters;
    }
}
