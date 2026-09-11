// SPDX-License-Identifier: UNLICENSED
pragma solidity =0.7.6;

import '../dex-core/Dex223Pool.sol';

// used for testing time dependent behavior
contract MockTestDex223Pool is Dex223Pool {

    // override set function limited to Factory
    function testset(
        address _t0erc223,
        address _t1erc223,
        address _library,
        address _converter
    ) external
    {
        pool_lib = _library;
        token0.erc223 = _t0erc223;
        token1.erc223 = _t1erc223;
        converter     = ITokenStandardConverter(_converter);
    }

    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bool prefer223,
        bytes memory data
    ) external override lock adjustableSender // noDelegateCall will not prevent delegatecalling
        // this method from the same contract via `tokenReceived` of ERC-223
    returns (int256 amount0, int256 amount1) {

        (bool success, bytes memory retdata) = pool_lib.delegatecall(abi.encodeWithSignature("swap(address,bool,int256,uint160,bool,bytes)", recipient, zeroForOne, amountSpecified, sqrtPriceLimitX96, prefer223, data));

        if (success) {
            (amount0, amount1) = abi.decode(retdata, (int256, int256));
        } else {
            if (retdata.length == 0) revert();
            assembly {
                revert(add(32, retdata), mload(retdata))
            }
        }
    }
}