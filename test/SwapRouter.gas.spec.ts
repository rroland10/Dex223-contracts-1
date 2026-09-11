import { abi as IUniswapV3PoolABI } from '../artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json'
import { BaseContract, ContractTransactionResponse, Wallet } from 'ethers'
import { ethers } from 'hardhat'
import {
  ERC223HybridToken,
  IUniswapV3Pool,
  IWETH9,
  MockTimeSwapRouter,
  TestERC20
} from '../typechain-types/'
import { completeFixture } from './shared/completeFixture'
import { FeeAmount, TICK_SPACINGS } from './shared/constants'
import { encodePriceSqrt, expandTo18Decimals, getMaxTick, getMinTick } from './shared/utilities'
import { encodePath } from './shared/path'
import snapshotGasCost from './shared/snapshotGasCost'
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect, use } from 'chai'
import { jestSnapshotPlugin } from 'mocha-chai-jest-snapshot'

use(jestSnapshotPlugin());

describe('SwapRouter gas tests', function () {
  this.timeout(40000)
  let wallet: Wallet
  let trader: Wallet

  async function swapRouterFixture(): Promise<{
    weth9: IWETH9
    router: MockTimeSwapRouter
    tokens: (TestERC20 | ERC223HybridToken)[]
    pools: IUniswapV3Pool[]
  }> {
    const { weth9, factory, router, tokens,
      nft , converter} = await completeFixture()

    // approve & fund wallets
    for (let i = 0; i < 7; i++) {
      if (i > 2 && i < 6) continue;
      const token = tokens[i] as TestERC20;
      await token.approve(router.target.toString(), ethers.MaxUint256);
      await token.approve(nft.target.toString(), ethers.MaxUint256);
      await token.connect(trader).approve(router.target.toString(), ethers.MaxUint256);
      // await token.transfer(trader.address, expandTo18Decimals(1_000_000));
    }

    for (let i = 0; i < 7; i++) {
      const token = tokens[i] as TestERC20;
      await token.transfer(trader.address, expandTo18Decimals(1_000_000));
    }

    const liquidity = 1000000;
    async function createPool(tokenAddressA0: string, tokenAddressB0: string, tokenAddressA1: string, tokenAddressB1: string) {
      if (tokenAddressA0.toLowerCase() > tokenAddressB0.toLowerCase()) {
        [tokenAddressA0, tokenAddressB0, tokenAddressA1, tokenAddressB1] = [tokenAddressB0, tokenAddressA0, tokenAddressB1, tokenAddressA1];
      }

      await nft.createAndInitializePoolIfNecessary(
          tokenAddressA0,
          tokenAddressB0,
          tokenAddressA1,
          tokenAddressB1,
          FeeAmount.MEDIUM,
          encodePriceSqrt(100005n, 100000n)
      );

      const liquidityParams = {
        token0: tokenAddressA0,
        token1: tokenAddressB0,
        fee: FeeAmount.MEDIUM,
        tickLower: getMinTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        tickUpper: getMaxTick(TICK_SPACINGS[FeeAmount.MEDIUM]),
        recipient: wallet.address,
        amount0Desired: 1000000,
        amount1Desired: 1000000,
        amount0Min: 0,
        amount1Min: 0,
        deadline: 1,
      }

      return nft.mint(liquidityParams);
    }

    async function createPoolWETH9(tokenAddress: string) {
      await weth9.deposit({ value: liquidity * 3 })
      await weth9.approve(nft.target.toString(), ethers.MaxUint256)
      // get addresses from converter
      let token3 = await converter.predictWrapperAddress(weth9.target.toString(), true);
      let token4 = await converter.predictWrapperAddress(tokenAddress, true);

      return createPool(weth9.target.toString(), tokenAddress, token3, token4)
    }

    // create pools
    await createPool(tokens[0].target.toString(), tokens[1].target.toString(), tokens[3].target.toString(), tokens[4].target.toString());
    await createPool(tokens[1].target.toString(), tokens[2].target.toString(), tokens[4].target.toString(), tokens[5].target.toString());
    await createPoolWETH9(tokens[0].target.toString());

    const poolAddresses = await Promise.all([
      factory.getPool(tokens[0].target.toString(), tokens[1].target.toString(), FeeAmount.MEDIUM),
      factory.getPool(tokens[1].target.toString(), tokens[2].target.toString(), FeeAmount.MEDIUM),
      factory.getPool(weth9.target.toString(), tokens[0].target.toString(), FeeAmount.MEDIUM),
    ])

    const pools: IUniswapV3Pool[] = poolAddresses.map((poolAddress) => {
        return (new ethers.Contract(poolAddress, IUniswapV3PoolABI, ethers.provider)) as BaseContract as IUniswapV3Pool
    })

    return {
      weth9,
      router,
      tokens,
      pools,
    }
  }

  let weth9: IWETH9
  let router: MockTimeSwapRouter
  let tokens: (TestERC20 | ERC223HybridToken)[]
  let pools: IUniswapV3Pool[]
  // let converter: TokenStandardConverter

  before('create fixture loader', async () => {
    ;[wallet, trader] = await (ethers as any).getSigners()
  })

  beforeEach('load fixture', async () => {
    ;({ router, weth9, tokens, pools } = await loadFixture(swapRouterFixture))
  })

  async function exactInput(
    tokens: string[],
    amountIn: number = 2,
    amountOutMinimum: number = 1
  ): Promise<ContractTransactionResponse> {
    const inputIsWETH = weth9.target.toString() === tokens[0]
    const outputIsWETH9 = tokens[tokens.length - 1] === weth9.target.toString()

    const value = inputIsWETH ? amountIn : 0

    const params = {
      path: encodePath(tokens, new Array(tokens.length - 1).fill(FeeAmount.MEDIUM)),
      recipient: outputIsWETH9 ? ethers.ZeroAddress : trader.address,
      deadline: 1,
      amountIn,
      amountOutMinimum: outputIsWETH9 ? 0 : amountOutMinimum, // save on calldata,
      prefer223Out: false
    }

    const data = [router.interface.encodeFunctionData('exactInput', [params])]
    if (outputIsWETH9) data.push(router.interface.encodeFunctionData('unwrapWETH9', [amountOutMinimum, trader.address]))

    // optimized for the gas test
    return data.length === 1
      ? router.connect(trader).exactInput(params, { value })
      : router.connect(trader).multicall(data, { value })
  }

  async function exactInputSingle(
    tokenIn: string,
    tokenOut: string,
    amountIn: number = 3,
    amountOutMinimum: number = 1,
    sqrtPriceLimitX96?: bigint
  ): Promise<ContractTransactionResponse> {
    const inputIsWETH = weth9.target.toString() === tokenIn
    const outputIsWETH9 = tokenOut === weth9.target.toString()

    const value = inputIsWETH ? amountIn : 0

    const params = {
      tokenIn,
      tokenOut,
      fee: FeeAmount.MEDIUM,
      sqrtPriceLimitX96: sqrtPriceLimitX96 ?? 0,
      recipient: outputIsWETH9 ? ethers.ZeroAddress : trader.address,
      deadline: 1,
      amountIn,
      amountOutMinimum: outputIsWETH9 ? 0 : amountOutMinimum, // save on calldata
      prefer223Out: false
    }

    const data = [router.interface.encodeFunctionData('exactInputSingle', [params])]
    if (outputIsWETH9) data.push(router.interface.encodeFunctionData('unwrapWETH9', [amountOutMinimum, trader.address]))

    // optimized for the gas test
    return data.length === 1
      ? router.connect(trader).exactInputSingle(params, { value })
      : router.connect(trader).multicall(data, { value })
  }

  async function exactOutput(tokens: string[]): Promise<ContractTransactionResponse> {
    const amountInMaximum = 10 // we don't care
    const amountOut = 1

    const inputIsWETH9 = tokens[0] === weth9.target.toString()
    const outputIsWETH9 = tokens[tokens.length - 1] === weth9.target.toString()

    const value = inputIsWETH9 ? amountInMaximum : 0

    const params = {
      path: encodePath(tokens.slice().reverse(), new Array(tokens.length - 1).fill(FeeAmount.MEDIUM)),
      recipient: outputIsWETH9 ? ethers.ZeroAddress : trader.address,
      deadline: 1,
      amountOut,
      amountInMaximum,
    }

    const data = [router.interface.encodeFunctionData('exactOutput', [params])]
    if (inputIsWETH9) data.push(router.interface.encodeFunctionData('refundETH'))
    if (outputIsWETH9) data.push(router.interface.encodeFunctionData('unwrapWETH9', [amountOut, trader.address]))

    return router.connect(trader).multicall(data, { value })
  }

  async function exactOutputSingle(
    tokenIn: string,
    tokenOut: string,
    amountOut: number = 1,
    amountInMaximum: number = 3,
    sqrtPriceLimitX96?: bigint
  ): Promise<ContractTransactionResponse> {
    const inputIsWETH9 = tokenIn === weth9.target.toString()
    const outputIsWETH9 = tokenOut === weth9.target.toString()

    const value = inputIsWETH9 ? amountInMaximum : 0

    const params = {
      tokenIn,
      tokenOut,
      fee: FeeAmount.MEDIUM,
      recipient: outputIsWETH9 ? ethers.ZeroAddress : trader.address,
      deadline: 1,
      amountOut,
      amountInMaximum,
      sqrtPriceLimitX96: sqrtPriceLimitX96 ?? 0,
    }

    const data = [router.interface.encodeFunctionData('exactOutputSingle', [params])]
    if (inputIsWETH9) data.push(router.interface.encodeFunctionData('unwrapWETH9', [0, trader.address]))
    if (outputIsWETH9) data.push(router.interface.encodeFunctionData('unwrapWETH9', [amountOut, trader.address]))

    return router.connect(trader).multicall(data, { value })
  }

  // TODO should really throw this in the fixture
  beforeEach('initialize feeGrowthGlobals', async () => {
    await exactInput([tokens[0].target.toString(), tokens[1].target.toString()], 1, 0)
    await exactInput([tokens[1].target.toString(), tokens[0].target.toString()], 1, 0)
    await exactInput([tokens[1].target.toString(), tokens[2].target.toString()], 1, 0)
    await exactInput([tokens[2].target.toString(), tokens[1].target.toString()], 1, 0)
    await exactInput([tokens[0].target.toString(), weth9.target.toString()], 1, 0)
    await exactInput([weth9.target.toString(), tokens[0].target.toString()], 1, 0)
  })

  beforeEach('ensure feeGrowthGlobals are >0', async () => {
    const slots = await Promise.all(
      pools.map((pool) =>
        Promise.all([
          pool.feeGrowthGlobal0X128().then((f) => f.toString()),
          pool.feeGrowthGlobal1X128().then((f) => f.toString()),
        ])
      )
    )

    expect(slots).to.deep.eq([
      ['340290874192793283295456993856614', '340290874192793283295456993856614'],
      ['340290874192793283295456993856614', '340290874192793283295456993856614'],
      ['340290874192793283295456993856614', '340290874192793283295456993856614'],
    ])
  })

  beforeEach('ensure ticks are 0 before', async () => {
    const slots = await Promise.all(pools.map((pool) => pool.slot0().then(({ tick }) => tick)))
    expect(slots).to.deep.eq([0, 0, 0])
  })

  afterEach('ensure ticks are 0 after', async () => {
    const slots = await Promise.all(pools.map((pool) => pool.slot0().then(({ tick }) => tick)))
    expect(slots).to.deep.eq([0, 0, 0])
  })

  describe('#exactInput', () => {
    it('0 -> 1', async () => {
      await snapshotGasCost(exactInput([tokens[0].target.toString(), tokens[1].target.toString()]))
    })

    it('0 -> 1 minimal', async () => {
      const calleeFactory = await ethers.getContractFactory('TestUniswapV3Callee')
      const callee = await calleeFactory.deploy()

      await tokens[0].connect(trader).approve(callee.target.toString(), ethers.MaxUint256)
      await snapshotGasCost(callee.connect(trader).swapExact0For1(pools[0].target.toString(), 2, trader.address, '4295128740'))
    })

    it('0 -> 1 -> 2', async () => {
      await snapshotGasCost(
        exactInput(
          tokens.slice(0,3).map((token) => token.target.toString()),
          3
        )
      )
    })

    it('WETH9 -> 0', async () => {
      await snapshotGasCost(
        exactInput(
          [weth9.target.toString(), tokens[0].target.toString()],
          weth9.target.toString().toLowerCase() < tokens[0].target.toString().toLowerCase() ? 2 : 3
        )
      )
    })

    it('0 -> WETH9', async () => {
      await snapshotGasCost(
        exactInput(
          [tokens[0].target.toString(), weth9.target.toString()],
          tokens[0].target.toString().toLowerCase() < weth9.target.toString().toLowerCase() ? 2 : 3
        )
      )
    })

    it('2 trades (via router)', async () => {
      await weth9.connect(trader).deposit({ value: 3 })
      await weth9.connect(trader).approve(router.target.toString(), ethers.MaxUint256)
      const swap0 = {
        path: encodePath([weth9.target.toString(), tokens[0].target.toString()], [FeeAmount.MEDIUM]),
        recipient: ethers.ZeroAddress,
        deadline: 1,
        amountIn: 3,
        amountOutMinimum: 0, // save on calldata
        prefer223Out: false
      }

      const swap1 = {
        path: encodePath([tokens[1].target.toString(), tokens[0].target.toString()], [FeeAmount.MEDIUM]),
        recipient: ethers.ZeroAddress,
        deadline: 1,
        amountIn: 3,
        amountOutMinimum: 0, // save on calldata
        prefer223Out: false
      }

      // NOTE: `sweepToken` was deliberately removed from PeripheryPayments ("inconsistency with the
      // ERC-223 workflow") - on an ERC-223 wrapper it would transfer balance that belongs to users'
      // tracked `_erc223Deposits`. The output therefore stays custodied by the router here.
      const data = [
        router.interface.encodeFunctionData('exactInput', [swap0]),
        router.interface.encodeFunctionData('exactInput', [swap1]),
      ]

      await snapshotGasCost(router.connect(trader).multicall(data))
    })

    it('3 trades (directly to sender)', async () => {
      await weth9.connect(trader).deposit({ value: 3 })
      await weth9.connect(trader).approve(router.target.toString(), ethers.MaxUint256)
      const swap0 = {
        path: encodePath([weth9.target.toString(), tokens[0].target.toString()], [FeeAmount.MEDIUM]),
        recipient: trader.address,
        deadline: 1,
        amountIn: 3,
        amountOutMinimum: 1,
        prefer223Out: false
      }

      const swap1 = {
        path: encodePath([tokens[0].target.toString(), tokens[1].target.toString()], [FeeAmount.MEDIUM]),
        recipient: trader.address,
        deadline: 1,
        amountIn: 3,
        amountOutMinimum: 1,
        prefer223Out: false
      }

      const swap2 = {
        path: encodePath([tokens[1].target.toString(), tokens[2].target.toString()], [FeeAmount.MEDIUM]),
        recipient: trader.address,
        deadline: 1,
        amountIn: 3,
        amountOutMinimum: 1,
        prefer223Out: false
      }

      const data = [
        router.interface.encodeFunctionData('exactInput', [swap0]),
        router.interface.encodeFunctionData('exactInput', [swap1]),
        router.interface.encodeFunctionData('exactInput', [swap2]),
      ]

      await snapshotGasCost(router.connect(trader).multicall(data))
    })
  })

  it('3 trades (directly to sender)', async () => {
    await weth9.connect(trader).deposit({ value: 3 })
    await weth9.connect(trader).approve(router.target.toString(), ethers.MaxUint256)
    const swap0 = {
      path: encodePath([weth9.target.toString(), tokens[0].target.toString()], [FeeAmount.MEDIUM]),
      recipient: trader.address,
      deadline: 1,
      amountIn: 3,
      amountOutMinimum: 1,
      prefer223Out: false
    }

    const swap1 = {
      path: encodePath([tokens[1].target.toString(), tokens[0].target.toString()], [FeeAmount.MEDIUM]),
      recipient: trader.address,
      deadline: 1,
      amountIn: 3,
      amountOutMinimum: 1,
      prefer223Out: false
    }

    const data = [
      router.interface.encodeFunctionData('exactInput', [swap0]),
      router.interface.encodeFunctionData('exactInput', [swap1]),
    ]

    await snapshotGasCost(router.connect(trader).multicall(data))
  })

  describe('#exactInputSingle', () => {
    it('0 -> 1', async () => {
      await snapshotGasCost(exactInputSingle(tokens[0].target.toString(), tokens[1].target.toString()))
    })

    it('WETH9 -> 0', async () => {
      await snapshotGasCost(
        exactInputSingle(
          weth9.target.toString(),
          tokens[0].target.toString(),
          weth9.target.toString().toLowerCase() < tokens[0].target.toString().toLowerCase() ? 2 : 3
        )
      )
    })

    it('0 -> WETH9', async () => {
      await snapshotGasCost(
        exactInputSingle(
          tokens[0].target.toString(),
          weth9.target.toString(),
          tokens[0].target.toString().toLowerCase() < weth9.target.toString().toLowerCase() ? 2 : 3
        )
      )
    })
  })

  describe('#exactOutput', () => {
    it('0 -> 1', async () => {
      await snapshotGasCost(exactOutput(tokens.slice(0, 2).map((token) => token.target.toString())))
    })

    it('0 -> 1 -> 2', async () => {
      await snapshotGasCost(exactOutput(tokens.slice(0, 3).map((token) => token.target.toString())))
    })

    it('WETH9 -> 0', async () => {
      await snapshotGasCost(exactOutput([weth9.target.toString(), tokens[0].target.toString()]))
    })

    it('0 -> WETH9', async () => {
      await snapshotGasCost(exactOutput([tokens[0].target.toString(), weth9.target.toString()]))
    })
  })

  describe('#exactOutputSingle', () => {
    it('0 -> 1', async () => {
      await snapshotGasCost(exactOutputSingle(tokens[0].target.toString(), tokens[1].target.toString()))
    })

    it('WETH9 -> 0', async () => {
      await snapshotGasCost(exactOutputSingle(weth9.target.toString(), tokens[0].target.toString()))
    })

    it('0 -> WETH9', async () => {
      await snapshotGasCost(exactOutputSingle(tokens[0].target.toString(), weth9.target.toString()))
    })
  })
})
