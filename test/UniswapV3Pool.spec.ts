import { ethers } from 'hardhat'
import { Wallet} from 'ethers'
import { expect } from 'chai'
import {
  TestERC20,
  ERC223HybridToken,
  Dex223Factory,
  MockTimeDex223Pool,
  TestUniswapV3SwapPay,
  TestUniswapV3Callee,
  TickMathTest,
  SwapMathTest, TokenStandardConverter, IWETH9
} from '../typechain-types/'
import checkObservationEquals from './shared/checkObservationEquals'
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

import { poolFixture, TEST_POOL_START_TIME } from './shared/fixtures'

import {
  expandTo18Decimals,
  FeeAmount,
  getPositionKey,
  getMaxTick,
  getMinTick,
  encodePriceSqrt,
  TICK_SPACINGS,
  createPoolFunctions,
  SwapFunction,
  MintFunction,
  getMaxLiquidityPerTick,
  // FlashFunction,
  MaxUint128,
  MAX_SQRT_RATIO,
  MIN_SQRT_RATIO,
  SwapToPriceFunction,
} from './shared/utilities'
import WETH9 from "./contracts/WETH9.json";

type ThenArg<T> = T extends PromiseLike<infer U> ? U : T

describe('Dex223Pool', () => {
  let wallet: Wallet, other: Wallet

  let token0: TestERC20;
  let token1: TestERC20;
  let token0_223: ERC223HybridToken;
  let token1_223: ERC223HybridToken;
  // let token2: TestERC20

  let factory: Dex223Factory
  let converter: TokenStandardConverter
  let pool: MockTimeDex223Pool

  let swapTarget: TestUniswapV3Callee

  let swapToLowerPrice: SwapToPriceFunction
  let swapToHigherPrice: SwapToPriceFunction
  let swapExact0For1: SwapFunction
  let swapExact1For0: SwapFunction
  let swapExact0For1_223: SwapFunction
  let swapExact1For0_223: SwapFunction

  let tickSpacing: bigint

  let minTick: bigint
  let maxTick: bigint

  let mint: MintFunction
  let mint223: MintFunction
  let mintMixed: MintFunction
  // let flash: FlashFunction

  let createPool: ThenArg<ReturnType<typeof poolFixture>>['createPool']

  before('create fixture loader', async () => {
    ;[wallet, other] = await (ethers as any).getSigners()
  })

  beforeEach('deploy fixture', async () => {
    ;({ token0, token1, factory, converter, createPool, swapTargetCallee: swapTarget } = await loadFixture(poolFixture));

    await token0.approve(converter.target.toString(), ethers.MaxUint256 / 2n);
    await token1.approve(converter.target.toString(), ethers.MaxUint256 / 2n);

    await converter.wrapERC20toERC223(token0.target, ethers.MaxUint256 / 2n);
    await converter.wrapERC20toERC223(token1.target, ethers.MaxUint256 / 2n);

    const TokenFactory = await ethers.getContractFactory('ERC223HybridToken');
    let tokenAddress = await converter.predictWrapperAddress(token0.target, true);
    token0_223 = TokenFactory.attach(tokenAddress) as ERC223HybridToken;
    tokenAddress = await converter.predictWrapperAddress(token1.target, true);
    token1_223 = TokenFactory.attach(tokenAddress) as ERC223HybridToken;

    const oldCreatePool = createPool;
    createPool = async (_feeAmount, _tickSpacing) => {
      const pool = await oldCreatePool(_feeAmount, _tickSpacing);
      ({
        swapToLowerPrice,
        swapToHigherPrice,
        swapExact0For1,
        swapExact1For0,
        swapExact1For0_223,
        swapExact0For1_223,
        mint,
        mint223,
        mintMixed
        // flash,
      } = createPoolFunctions({
        token0,
        token1,
        token0_223,
        token1_223,
        swapTarget,
        pool,
      }));
      minTick = getMinTick(_tickSpacing);
      maxTick = getMaxTick(_tickSpacing);
      // feeAmount = _feeAmount
      tickSpacing = BigInt(_tickSpacing);
      return pool;
    }

    // default to the 30 bips pool
    pool = await createPool(FeeAmount.MEDIUM, TICK_SPACINGS[FeeAmount.MEDIUM]);
  })

  it('constructor initializes immutables', async () => {
    const token0_223 = await converter.predictWrapperAddress(token0.target, true);
    const token1_223 = await converter.predictWrapperAddress(token1.target, true);
    expect(await pool.factory()).to.eq(factory.target.toString());
    expect(await pool.token0()).to.deep.eq([token0.target.toString(), token0_223]);
    expect(await pool.token1()).to.deep.eq([token1.target.toString(), token1_223]);
    expect(await pool.maxLiquidityPerTick()).to.eq(getMaxLiquidityPerTick(Number(tickSpacing)));
  })

  describe('#initialize', () => {
    it('fails if already initialized', async () => {
      await pool.initialize(encodePriceSqrt(1n, 1n))
      await expect(pool.initialize(encodePriceSqrt(1n, 1n))).to.be.reverted
    })
    it('fails if starting price is too low', async () => {
      await expect(pool.initialize(1)).to.be.revertedWith('R')
      await expect(pool.initialize(MIN_SQRT_RATIO - 1n)).to.be.revertedWith('R')
    })
    it('fails if starting price is too high', async () => {
      await expect(pool.initialize(MAX_SQRT_RATIO)).to.be.revertedWith('R')
      await expect(pool.initialize(2n ** 160n - 1n)).to.be.revertedWith('R')
    })
    it('can be initialized at MIN_SQRT_RATIO', async () => {
      await pool.initialize(MIN_SQRT_RATIO)
      expect((await pool.slot0()).tick).to.eq(getMinTick(1))
    })
    it('can be initialized at MAX_SQRT_RATIO - 1', async () => {
      await pool.initialize(MAX_SQRT_RATIO - 1n)
      expect((await pool.slot0()).tick).to.eq(getMaxTick(1) - 1n)
    })
    it('sets initial variables', async () => {
      const price = encodePriceSqrt(1n, 2n)
      await pool.initialize(price)

      const { sqrtPriceX96, observationIndex } = await pool.slot0()
      expect(sqrtPriceX96).to.eq(price)
      expect(observationIndex).to.eq(0n)
      expect((await pool.slot0()).tick).to.eq(-6932n)
    })
    it('initializes the first observations slot', async () => {
      await pool.initialize(encodePriceSqrt(1n, 1n))
      checkObservationEquals(await pool.observations(0n), {
        secondsPerLiquidityCumulativeX128: 0n,
        initialized: true,
        blockTimestamp: TEST_POOL_START_TIME,
        tickCumulative: 0n,
      })
    })
    it('emits a Initialized event with the input tick', async () => {
      const sqrtPriceX96 = encodePriceSqrt(1n, 2n)
      await expect(pool.initialize(sqrtPriceX96)).to.emit(pool, 'Initialize').withArgs(sqrtPriceX96, -6932n)
    })
  })

  describe('#factory', () => {
    it('pool creation: ERC-20(exist) & ERC-223(non exist) - should pass', async () => {
      // 1. Существует ERC-20 токен, не существует ERC-223 версии, но она может быть создана в конвертере - это должно работать.
      const token20Factory = await ethers.getContractFactory('TestERC20');
      const tokenA = (await token20Factory.deploy(ethers.MaxUint256)) as TestERC20;
      const tokenB = (await token20Factory.deploy(ethers.MaxUint256)) as TestERC20;
      let tokenA223 = await converter.predictWrapperAddress(tokenA.target, true);
      let tokenB223 = await converter.predictWrapperAddress(tokenB.target, true);
      
      await expect(factory.createPool(tokenA.target, tokenB.target, tokenA223, tokenB223, 3000n)).not.to.be.reverted;
    });

    it('pool creation: ERC-20(exist) & ERC-223(exist - wrapper) - should pass', async () => {
      // 2. Существуют обе версии, ERC-20 и ERC-223-Wrapper созданная в конвертере - это должно работать.
      const token20Factory = await ethers.getContractFactory('TestERC20');
      const tokenA = (await token20Factory.deploy(ethers.MaxUint256)) as TestERC20;
      const tokenB = (await token20Factory.deploy(ethers.MaxUint256)) as TestERC20;
      
      // convert tokenA ERC-20 to ERC-223
      await (await converter.createERC223Wrapper(tokenA.target)).wait();
      let tokenA223 = await converter.getERC223WrapperFor(tokenA.target);
      let tokenB223 = await converter.predictWrapperAddress(tokenB.target, true);

      await expect(factory.createPool(tokenA.target, tokenB.target, tokenA223, tokenB223, 3000n)).not.to.be.reverted;
    });
    
    it('pool creation: ERC-20(exist - wrapper) & ERC-223(exist) - should pass', async () => {
      // 3. Существуют обе версии, ERC-223 и ERC-20-Wrapper - должно работать.
      const token20Factory = await ethers.getContractFactory('TestERC20');
      const token223Factory = await ethers.getContractFactory('ERC223HybridToken');
      
      // deploy tokenA as ERC233
      const tokenA_223 = (await token223Factory.deploy('erc223', 'E23', 6n)) as ERC223HybridToken;
      const tokenB = (await token20Factory.deploy(ethers.MaxUint256)) as TestERC20;

      // convert tokenA ERC-223 to ERC-20
      await (await converter.createERC20Wrapper(tokenA_223.target)).wait();
      let tokenA_20 = await converter.getERC20WrapperFor(tokenA_223.target);
      let tokenB223 = await converter.predictWrapperAddress(tokenB.target, true);

      await expect(factory.createPool(tokenA_20, tokenB.target, tokenA_223.target, tokenB223, 3000n)).not.to.be.reverted;
    });
    
    it('pool creation: ERC-20(not exist - predict) & ERC-223(exist) - should pass', async () => {
      // 4. Существует ERC-223, не существует ERC-20 - должно работать.
      const token20Factory = await ethers.getContractFactory('TestERC20');
      const token223Factory = await ethers.getContractFactory('ERC223HybridToken');

      // deploy tokenA as ERC233
      const tokenA_223 = (await token223Factory.deploy('erc223', 'E23', 6n)) as ERC223HybridToken;
      const tokenB = (await token20Factory.deploy(ethers.MaxUint256)) as TestERC20;

      // predict tokenA ERC-20 from ERC-223
      let tokenA_20 = await converter.predictWrapperAddress(tokenA_223.target, false);
      let tokenB223 = await converter.predictWrapperAddress(tokenB.target, true);

      await expect(factory.createPool(tokenA_20, tokenB.target, tokenA_223.target, tokenB223, 3000n)).not.to.be.reverted;
    });

    it('pool creation: ERC-20 = WETH9  & ERC-223(not exist) - should pass', async () => {
      const token20Factory = await ethers.getContractFactory('TestERC20');
      const [owner] = await ethers.getSigners();
      const wethFactory = new ethers.ContractFactory(WETH9.abi, WETH9.bytecode, owner);
      const weth9 = (await wethFactory.deploy()) as IWETH9;
      const tokenB = (await token20Factory.deploy(ethers.MaxUint256)) as TestERC20;

      // convert tokenA ERC-20 to ERC-223
      let weth9_223 = await converter.predictWrapperAddress(weth9.target, true);
      let tokenB223 = await converter.predictWrapperAddress(tokenB.target, true);

      await expect(factory.createPool(weth9.target, tokenB.target, weth9_223, tokenB223, 3000n)).not.to.be.reverted;
    });
    
    it('pool creation: should fail versions', async () => {
      // prepare tokens
      const token223Factory = await ethers.getContractFactory('ERC223HybridToken');
      const token20Factory = await ethers.getContractFactory('TestERC20');
      const tokenA = (await token20Factory.deploy(ethers.MaxUint256)) as TestERC20;
      const tokenB = (await token20Factory.deploy(ethers.MaxUint256)) as TestERC20;
      const token223 = (await token223Factory.deploy('erc223', 'E23', 6n)) as ERC223HybridToken;
      let tokenA223 = await converter.predictWrapperAddress(tokenA.target, true);
      let tokenB223 = await converter.predictWrapperAddress(tokenB.target, true);
      
      // console.log('tokenA = tokenB');
      await expect(factory.createPool(tokenA.target, tokenA.target, tokenA223, tokenB223, 3000n)).to.be.reverted;
      // console.log('tokenA = 0');
      await expect(factory.createPool(ethers.ZeroAddress, tokenB.target, tokenA223, tokenB223, 3000n)).to.be.reverted;
      // console.log('tokenB = 0');
      await expect(factory.createPool(tokenA.target, ethers.ZeroAddress, tokenA223, tokenB223, 3000n)).to.be.reverted;
      // console.log('tokenA(223) = 0');
      await expect(factory.createPool(tokenA.target, tokenB.target, ethers.ZeroAddress, tokenB223, 3000n)).to.be.reverted;
      // console.log('tokenB(223) = 0');
      await expect(factory.createPool(tokenA.target, tokenB.target, tokenA223, ethers.ZeroAddress, 3000n)).to.be.reverted;
      // console.log('tokenA is not ERC20');
      await expect(factory.createPool(token223.target, tokenB.target, tokenA223, tokenB223, 3000n)).to.be.reverted;
      // console.log('tokenB is not ERC20');
      await expect(factory.createPool(tokenA.target, token223.target, tokenA223, tokenB223, 3000n)).to.be.reverted;
      
      // console.log('tokenA is ERC223 wrapper for ERC20');
      await expect(factory.createPool(tokenA223, tokenB.target, tokenA.target, tokenB223, 3000n)).to.be.reverted;
      // console.log('tokenB is ERC223 wrapper for ERC20');
      await expect(factory.createPool(tokenA.target, tokenB223, tokenA223, tokenB.target, 3000n)).to.be.reverted;

      // 5. Юзер пытается подать два разных токена, один ERC-20 и другой ERC-223 как версии одного токена, когда они никак не связаны через конвертер - должно отклоняться.
      await expect(factory.createPool(tokenA.target, tokenB.target, token223.target, tokenB223, 3000n)).to.be.reverted;
      
      // 6. Юзер создает для ERC-20 версии ERC-20-Wrapper и подает как две версии одного токена, претендуя что ERC-20-оригинал это на самом деле ERC-223-оригинал - должно отклоняться.
      // console.log('tokenA is ERC20 wrap on another ERC20');
      // imitate ERC20 token got from valid ERC20 token wrapping
      await (await converter.createERC20Wrapper(tokenA.target)).wait();
      const tokenA20_wrap = await converter.predictWrapperAddress(tokenA.target, false);
      await expect(factory.createPool(tokenA20_wrap, tokenB.target, tokenA.target, tokenB223, 3000n)).to.be.reverted;

      // 7. Юзер создает для ERC-223 версии ERC-223-Wrapper, аналогично предыдущему пункту - должно отклоняться.
      // console.log('tokenA is ERC223 wrap on another ERC223');
      // imitate ERC223 token got from valid ERC223 token wrapping
      await (await converter.createERC223Wrapper(token223.target)).wait();
      const tokenA223_wrap223 = await converter.predictWrapperAddress(token223.target, true);
      await expect(factory.createPool(token223.target, tokenB.target, tokenA223_wrap223, tokenB223, 3000n)).to.be.reverted;

      // console.log('wrong fee');
      await expect(factory.createPool(tokenA.target, tokenB.target, tokenA223, tokenB223, 3005n)).to.be.reverted;
      // console.log('existing pool');
      await factory.createPool(token0.target, token1.target, token0_223.target, token1_223.target, 3000n);
      await expect(factory.createPool(token0.target, token1.target, token0_223.target, token1_223.target, 3000n)).to.be.reverted;
    });
  });

  describe('#increaseObservationCardinalityNext', () => {
    it('can only be called after initialize', async () => {
      await expect(pool.increaseObservationCardinalityNext(2)).to.be.revertedWith('LOK')
    })
    it('emits an event including both old and new', async () => {
      await pool.initialize(encodePriceSqrt(1n, 1n))
      await expect(pool.increaseObservationCardinalityNext(2))
        .to.emit(pool, 'IncreaseObservationCardinalityNext')
        .withArgs(1, 2)
    })
    it('does not emit an event for no op call', async () => {
      await pool.initialize(encodePriceSqrt(1n, 1n))
      await pool.increaseObservationCardinalityNext(3)
      await expect(pool.increaseObservationCardinalityNext(2)).to.not.emit(pool, 'IncreaseObservationCardinalityNext')
    })
    it('does not change cardinality next if less than current', async () => {
      await pool.initialize(encodePriceSqrt(1n, 1n))
      await pool.increaseObservationCardinalityNext(3)
      await pool.increaseObservationCardinalityNext(2)
      expect((await pool.slot0()).observationCardinalityNext).to.eq(3n)
    })
    it('increases cardinality and cardinality next first time', async () => {
      await pool.initialize(encodePriceSqrt(1n, 1n))
      await pool.increaseObservationCardinalityNext(2)
      const { observationCardinality, observationCardinalityNext } = await pool.slot0()
      expect(observationCardinality).to.eq(1n)
      expect(observationCardinalityNext).to.eq(2n)
    })
  })

  describe('#mint', () => {
    it('fails if not initialized', async () => {
      await expect(mint(wallet.address, -tickSpacing, tickSpacing, 1n)).to.be.revertedWith('LOK')
    })
    describe('after initialization', () => {
      beforeEach('initialize the pool at price of 10:1', async () => {
        const price: bigint = encodePriceSqrt(1n, 10n);
        await pool.initialize(price)
        await mint(wallet.address, minTick, maxTick, 3161n)
      })

      describe('failure cases', () => {
        it('fails if tickLower greater than tickUpper', async () => {
          // should be TLU but...hardhat
          await expect(mint(wallet.address, 1n, 0n, 1n)).to.be.reverted
        })
        it('fails if tickLower less than min tick', async () => {
          // should be TLM but...hardhat
          await expect(mint(wallet.address, -887273n, 0n, 1n)).to.be.reverted
        })
        it('fails if tickUpper greater than max tick', async () => {
          // should be TUM but...hardhat
          await expect(mint(wallet.address, 0n, 887273n, 1n)).to.be.reverted
        })
        it('fails if amount exceeds the max', async () => {
          // these should fail with 'LO' but hardhat is bugged
          const maxLiquidityGross = await pool.maxLiquidityPerTick()
          await expect(mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, maxLiquidityGross + 1n)).to
            .be.reverted
          await expect(mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, maxLiquidityGross)).to.not.be
            .reverted
        })
        it('fails if total amount at tick exceeds the max', async () => {
          // these should fail with 'LO' but hardhat is bugged
          await mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, 1000n)

          const maxLiquidityGross = await pool.maxLiquidityPerTick()
          await expect(
            mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, maxLiquidityGross - 1000n + 1n)
          ).to.be.reverted
          await expect(
            mint(wallet.address, minTick + tickSpacing * 2n, maxTick - tickSpacing, maxLiquidityGross - 1000n + 1n)
          ).to.be.reverted
          await expect(
            mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing * 2n, maxLiquidityGross - 1000n + 1n)
          ).to.be.reverted
          await expect(mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, maxLiquidityGross - 1000n))
            .to.not.be.reverted
        })
        it('fails if amount is 0', async () => {
          await expect(mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, 0n)).to.be.reverted
        })
      })

      describe('success cases', () => {
        it('initial balances', async () => {
          expect(await token0.balanceOf(pool.target.toString())).to.eq(9996n)
          expect(await token1.balanceOf(pool.target.toString())).to.eq(1000n)
        })

        it('initial tick', async () => {
          expect((await pool.slot0()).tick).to.eq(-23028n)
        })

        describe('above current price', () => {
          it('transfers token0 only', async () => {
            await expect(mint(wallet.address, -22980n, 0n, 10000n))
              .to.emit(token0, 'Transfer')
              .withArgs(wallet.address, pool.target.toString(), 21549n)
              .to.not.emit(token1, 'Transfer')
            expect(await token0.balanceOf(pool.target.toString())).to.eq(9996n + 21549n)
            expect(await token1.balanceOf(pool.target.toString())).to.eq(1000n)
          });

          it('(223) transfers token0 only', async () => {
            await expect(mint223(wallet.address, -22980n, 0n, 10000n))
                .to.emit(swapTarget, 'MintCallback')
                .to.emit(token0_223, 'Transfer(address,address,uint256)')
                .withArgs(swapTarget.target.toString(), pool.target.toString(), 21549n)
            expect(await token0.balanceOf(pool.target.toString()) + await token0_223.balanceOf(pool.target.toString())).to.eq(9996n + 21549n);
            expect(await token1.balanceOf(pool.target.toString()) + await token1_223.balanceOf(pool.target.toString())).to.eq(1000n);
          });

          it('(223-20) transfers token0 only', async () => {
            await expect(mintMixed(wallet.address, -22980n, 0n, 10000n))
                .to.emit(swapTarget, 'MintCallback')
                .to.emit(token0_223, 'Transfer(address,address,uint256)')
                .withArgs(swapTarget.target.toString(), pool.target.toString(), 21549n)
                .to.not.emit(token1, 'Transfer')
            expect(await token0.balanceOf(pool.target.toString()) + await token0_223.balanceOf(pool.target.toString())).to.eq(9996n + 21549n);
            expect(await token1.balanceOf(pool.target.toString())).to.eq(1000n);
          });

          it('max tick with max leverage', async () => {
            await mint(wallet.address, maxTick - tickSpacing, maxTick, 2n ** 102n)
            expect(await token0.balanceOf(pool.target.toString())).to.eq(9996n + 828011525n)
            expect(await token1.balanceOf(pool.target.toString())).to.eq(1000n)
          })

          it('(223) max tick with max leverage', async () => {
            await mint223(wallet.address, maxTick - tickSpacing, maxTick, 2n ** 102n)
            expect(await token0.balanceOf(pool.target.toString()) + await token0_223.balanceOf(pool.target.toString())).to.eq(9996n + 828011525n)
            expect(await token1.balanceOf(pool.target.toString())).to.eq(1000n)
          })

          it('works for max tick', async () => {
            await expect(mint(wallet.address, -22980n, maxTick, 10000n))
              .to.emit(token0, 'Transfer')
              .withArgs(wallet.address, pool.target.toString(), 31549n)
            expect(await token0.balanceOf(pool.target.toString())).to.eq(9996n + 31549n)
            expect(await token1.balanceOf(pool.target.toString())).to.eq(1000n)
          })

          it('(223) works for max tick', async () => {
            await expect(mint223(wallet.address, -22980n, maxTick, 10000n))
              .to.emit(token0_223, 'Transfer(address,address,uint256)')
              .withArgs(swapTarget.target, pool.target.toString(), 31549n)
            expect(await token0.balanceOf(pool.target.toString()) + await token0_223.balanceOf(pool.target.toString())).to.eq(9996n + 31549n)
            expect(await token1.balanceOf(pool.target.toString())).to.eq(1000n)
          })

          it('removing works', async () => {
            await mint(wallet.address, -240n, 0n, 10000n)
            await pool.burn(-240n, 0n, 10000n)
            // @ts-ignore
            const { amount0, amount1 } = await pool.collect.staticCall(
                wallet.address, -240n, 0n, MaxUint128, MaxUint128, false, false)
            expect(amount0, 'amount0').to.eq(120n)
            expect(amount1, 'amount1').to.eq(0n)
          })

          it('(223) removing works', async () => {
            await mint223(wallet.address, -240n, 0n, 10000n)
            await pool.burn(-240n, 0n, 10000n)
            // @ts-ignore
            const { amount0, amount1 } = await pool.collect.staticCall(
                wallet.address, -240n, 0n, MaxUint128, MaxUint128, false, false)
            expect(amount0, 'amount0').to.eq(120n)
            expect(amount1, 'amount1').to.eq(0n)
          })

          it('(223) adds liquidity to liquidityGross', async () => {
            await mint(wallet.address, -240n, 0n, 100n)
            expect((await pool.ticks(-240n)).liquidityGross).to.eq(100n)
            expect((await pool.ticks(0n)).liquidityGross).to.eq(100n)
            expect((await pool.ticks(tickSpacing)).liquidityGross).to.eq(0n)
            expect((await pool.ticks(tickSpacing * 2n)).liquidityGross).to.eq(0n)
            await mint223(wallet.address, -240n, tickSpacing, 150n)
            expect((await pool.ticks(-240n)).liquidityGross).to.eq(250n)
            expect((await pool.ticks(0n)).liquidityGross).to.eq(100n)
            expect((await pool.ticks(tickSpacing)).liquidityGross).to.eq(150n)
            expect((await pool.ticks(tickSpacing * 2n)).liquidityGross).to.eq(0n)
            await mint223(wallet.address, 0n, tickSpacing * 2n, 60n)
            expect((await pool.ticks(-240n)).liquidityGross).to.eq(250n)
            expect((await pool.ticks(0n)).liquidityGross).to.eq(160n)
            expect((await pool.ticks(tickSpacing)).liquidityGross).to.eq(150n)
            expect((await pool.ticks(tickSpacing * 2n)).liquidityGross).to.eq(60n)
          })

          it('(223) removes liquidity from liquidityGross', async () => {
            await mint(wallet.address, -240n, 0n, 100n)
            await mint223(wallet.address, -240n, 0n, 40n)
            await pool.burn(-240n, 0n, 90n)
            expect((await pool.ticks(-240n)).liquidityGross).to.eq(50n)
            expect((await pool.ticks(0n)).liquidityGross).to.eq(50n)
          })

          it('clears tick lower if last position is removed', async () => {
            await mint(wallet.address, -240n, 0n, 100n)
            await pool.burn(-240n, 0n, 100n)
            const { liquidityGross, feeGrowthOutside0X128, feeGrowthOutside1X128 } = await pool.ticks(-240n)
            expect(liquidityGross).to.eq(0n)
            expect(feeGrowthOutside0X128).to.eq(0n)
            expect(feeGrowthOutside1X128).to.eq(0n)
          })

          it('clears tick upper if last position is removed', async () => {
            await mint(wallet.address, -240n, 0n, 100n)
            await pool.burn(-240n, 0n, 100n)
            const { liquidityGross, feeGrowthOutside0X128, feeGrowthOutside1X128 } = await pool.ticks(0n)
            expect(liquidityGross).to.eq(0n)
            expect(feeGrowthOutside0X128).to.eq(0n)
            expect(feeGrowthOutside1X128).to.eq(0n)
          })

          it('(223) only clears the tick that is not used at all', async () => {
            await mint(wallet.address, -240n, 0n, 100n)
            await mint223(wallet.address, -tickSpacing, 0n, 250n)
            await pool.burn(-240n, 0n, 100n)

            let { liquidityGross, feeGrowthOutside0X128, feeGrowthOutside1X128 } = await pool.ticks(-240n)
            expect(liquidityGross).to.eq(0n)
            expect(feeGrowthOutside0X128).to.eq(0n)
            expect(feeGrowthOutside1X128).to.eq(0n)
            ;({ liquidityGross, feeGrowthOutside0X128, feeGrowthOutside1X128 } = await pool.ticks(-tickSpacing))
            expect(liquidityGross).to.eq(250n)
            expect(feeGrowthOutside0X128).to.eq(0n)
            expect(feeGrowthOutside1X128).to.eq(0n)
          })

          it('does not write an observation', async () => {
            checkObservationEquals(await pool.observations(0n), {
              tickCumulative: 0n,
              blockTimestamp: TEST_POOL_START_TIME,
              initialized: true,
              secondsPerLiquidityCumulativeX128: 0n,
            })
            await pool.advanceTime(1)
            await mint(wallet.address, -240n, 0n, 100n)
            checkObservationEquals(await pool.observations(0n), {
              tickCumulative: 0n,
              blockTimestamp: TEST_POOL_START_TIME,
              initialized: true,
              secondsPerLiquidityCumulativeX128: 0n,
            })
          })
        })

        describe('including current price', () => {
          it('price within range: transfers current price of both tokens', async () => {
            await expect(mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, 100n))
              .to.emit(token0, 'Transfer')
              .withArgs(wallet.address, pool.target.toString(), 317n)
              .to.emit(token1, 'Transfer')
              .withArgs(wallet.address, pool.target.toString(), 32n)
            expect(await token0.balanceOf(pool.target.toString())).to.eq(9996n + 317n)
            expect(await token1.balanceOf(pool.target.toString())).to.eq(1000n + 32n)
          })

          it('(223) price within range: transfers current price of both tokens', async () => {
            await expect(mint223(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, 100n))
                .to.emit(token0_223, 'Transfer(address,address,uint256)')
                .withArgs(swapTarget.target, pool.target.toString(), 317n)
                .to.emit(token1_223, 'Transfer(address,address,uint256)')
                .withArgs(swapTarget.target, pool.target.toString(), 32n)
            expect(await token0.balanceOf(pool.target.toString()) + await token0_223.balanceOf(pool.target.toString())).to.eq(9996n + 317n)
            expect(await token1.balanceOf(pool.target.toString()) + await token1_223.balanceOf(pool.target.toString())).to.eq(1000n + 32n)
          })

          it('(223-20) price within range: transfers current price of both tokens', async () => {
            await expect(mintMixed(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, 100n))
                .to.emit(token0_223, 'Transfer(address,address,uint256)')
                .withArgs(swapTarget.target, pool.target, 317n)
                .to.emit(token1, 'Transfer')
                .withArgs(wallet.address, pool.target, 32n)
            expect(await token0.balanceOf(pool.target) + await token0_223.balanceOf(pool.target)).to.eq(9996n + 317n)
            expect(await token1.balanceOf(pool.target)).to.eq(1000n + 32n)
          })

          it('initializes lower tick', async () => {
            await mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, 100n)
            const { liquidityGross } = await pool.ticks(minTick + tickSpacing)
            expect(liquidityGross).to.eq(100n)
          })

          it('initializes upper tick', async () => {
            await mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, 100n)
            const { liquidityGross } = await pool.ticks(maxTick - tickSpacing)
            expect(liquidityGross).to.eq(100n)
          })

          it('works for min/max tick', async () => {
            await expect(mint(wallet.address, minTick, maxTick, 10000n))
              .to.emit(token0, 'Transfer')
              .withArgs(wallet.address, pool.target.toString(), 31623n)
              .to.emit(token1, 'Transfer')
              .withArgs(wallet.address, pool.target.toString(), 3163n)
            expect(await token0.balanceOf(pool.target.toString())).to.eq(9996n + 31623n)
            expect(await token1.balanceOf(pool.target.toString())).to.eq(1000n + 3163n)
          })

          it('(223) works for min/max tick', async () => {
            await expect(mint223(wallet.address, minTick, maxTick, 10000n))
              .to.emit(token0_223, 'Transfer(address,address,uint256)')
              .withArgs(swapTarget.target, pool.target, 31623n)
              .to.emit(token1_223, 'Transfer(address,address,uint256)')
              .withArgs(swapTarget.target, pool.target, 3163n)
            expect(await token0.balanceOf(pool.target) + await token0_223.balanceOf(pool.target)).to.eq(9996n + 31623n)
            expect(await token1.balanceOf(pool.target) + await token1_223.balanceOf(pool.target)).to.eq(1000n + 3163n)
          })

          it('removing works', async () => {
            await mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, 100n)
            await pool.burn(minTick + tickSpacing, maxTick - tickSpacing, 100n)
            // @ts-ignore
            const { amount0, amount1 } = await pool.collect.staticCall(
              wallet.address,
              minTick + tickSpacing,
              maxTick - tickSpacing,
              MaxUint128,
              MaxUint128,
                false,
                false
            )
            expect(amount0, 'amount0').to.eq(316n)
            expect(amount1, 'amount1').to.eq(31n)
          })

          it('writes an observation', async () => {
            checkObservationEquals(await pool.observations(0n), {
              tickCumulative: 0n,
              blockTimestamp: TEST_POOL_START_TIME,
              initialized: true,
              secondsPerLiquidityCumulativeX128: 0n,
            })
            await pool.advanceTime(1)
            await mint(wallet.address, minTick, maxTick, 100n)
            checkObservationEquals(await pool.observations(0n), {
              tickCumulative: -23028n,
              blockTimestamp: TEST_POOL_START_TIME + 1n,
              initialized: true,
              secondsPerLiquidityCumulativeX128: 107650226801941937191829992860413859n,
            })
          })
        })

        describe('below current price', () => {
          it('transfers token1 only', async () => {
            await expect(mint(wallet.address, -46080n, -23040n, 10000n))
              .to.emit(token1, 'Transfer')
              .withArgs(wallet.address, pool.target.toString(), 2162n)
              .to.not.emit(token0, 'Transfer')
            expect(await token0.balanceOf(pool.target.toString())).to.eq(9996n)
            expect(await token1.balanceOf(pool.target.toString())).to.eq(1000n + 2162n)
          })

          it('(223) transfers token1 only', async () => {
            await expect(mint223(wallet.address, -46080n, -23040n, 10000n))
              .to.emit(token1_223, 'Transfer(address,address,uint256)')
              .withArgs(swapTarget.target, pool.target, 2162n)
              // .to.not.emit(token0, 'Transfer')
            expect(await token0.balanceOf(pool.target)).to.eq(9996n)
            expect(await token1.balanceOf(pool.target) + await token1_223.balanceOf(pool.target)).to.eq(1000n + 2162n)
          })

          it('min tick with max leverage', async () => {
            await mint(wallet.address, minTick, minTick + tickSpacing, 2n ** 102n)
            expect(await token0.balanceOf(pool.target.toString())).to.eq(9996n)
            expect(await token1.balanceOf(pool.target.toString())).to.eq(1000n + 828011520n)
          })

          it('works for min tick', async () => {
            await expect(mint(wallet.address, minTick, -23040n, 10000n))
              .to.emit(token1, 'Transfer')
              .withArgs(wallet.address, pool.target.toString(), 3161n)
            expect(await token0.balanceOf(pool.target.toString())).to.eq(9996n)
            expect(await token1.balanceOf(pool.target.toString())).to.eq(1000n + 3161n)
          })

          it('removing works', async () => {
            await mint(wallet.address, -46080n, -46020n, 10000n)
            await pool.burn(-46080n, -46020n, 10000n)
            // @ts-ignore
            const { amount0, amount1 } = await pool.collect.staticCall(
              wallet.address,
              -46080n,
              -46020n,
              MaxUint128,
              MaxUint128,
                false,
                false
            )
            expect(amount0, 'amount0').to.eq(0n)
            expect(amount1, 'amount1').to.eq(3n)
          })

          it('does not write an observation', async () => {
            checkObservationEquals(await pool.observations(0n), {
              tickCumulative: 0n,
              blockTimestamp: TEST_POOL_START_TIME,
              initialized: true,
              secondsPerLiquidityCumulativeX128: 0n,
            })
            await pool.advanceTime(1n)
            await mint(wallet.address, -46080n, -23040n, 100n)
            checkObservationEquals(await pool.observations(0n),
                {
              tickCumulative: 0n,
              blockTimestamp: TEST_POOL_START_TIME,
              initialized: true,
              secondsPerLiquidityCumulativeX128: 0n,
            })
          })
        })
      })

      it('protocol fees accumulate as expected during swap', async () => {
        await pool.setFeeProtocol(6n, 6n)

        await mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, expandTo18Decimals(1))
        await swapExact0For1(expandTo18Decimals(1) / 10n, wallet.address)
        await swapExact1For0(expandTo18Decimals(1) / 100n, wallet.address)

        let { token0: token0ProtocolFees, token1: token1ProtocolFees } = await pool.protocolFees()
        expect(token0ProtocolFees).to.eq(50000000000000n)
        expect(token1ProtocolFees).to.eq(5000000000000n)
      })

      it('(223) protocol fees accumulate as expected during swap', async () => {
        await pool.setFeeProtocol(6n, 6n)

        await mint223(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, expandTo18Decimals(1))
        await swapExact0For1_223(expandTo18Decimals(1) / 10n, wallet.address)
        await swapExact1For0_223(expandTo18Decimals(1) / 100n, wallet.address)

        let { token0: token0ProtocolFees, token1: token1ProtocolFees } = await pool.protocolFees()
        expect(token0ProtocolFees).to.eq(50000000000000n)
        expect(token1ProtocolFees).to.eq(5000000000000n)
      })

      it('positions are protected before protocol fee is turned on', async () => {
        await mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, expandTo18Decimals(1))
        await swapExact0For1(expandTo18Decimals(1) / 10n, wallet.address)
        await swapExact1For0(expandTo18Decimals(1) / 100n, wallet.address)

        let { token0: token0ProtocolFees, token1: token1ProtocolFees } = await pool.protocolFees()
        expect(token0ProtocolFees).to.eq(0n)
        expect(token1ProtocolFees).to.eq(0n)

        await pool.setFeeProtocol(6n, 6n)
        ;({ token0: token0ProtocolFees, token1: token1ProtocolFees } = await pool.protocolFees())
        expect(token0ProtocolFees).to.eq(0n)
        expect(token1ProtocolFees).to.eq(0n)
      })

      it('(223) poke is not allowed on uninitialized position', async () => {
        await mint223(other.address, minTick + tickSpacing, maxTick - tickSpacing, expandTo18Decimals(1))
        await swapExact0For1_223(expandTo18Decimals(1) / 10n, wallet.address)
        await swapExact1For0_223(expandTo18Decimals(1) / 100n, wallet.address)

        // missing revert reason due to hardhat
        await expect(pool.burn(minTick + tickSpacing, maxTick - tickSpacing, 0n)).to.be.reverted

        await mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, 1n)
        let {
          liquidity,
          feeGrowthInside0LastX128,
          feeGrowthInside1LastX128,
          tokensOwed1,
          tokensOwed0,
        } = await pool.positions(getPositionKey(wallet.address, minTick + tickSpacing, maxTick - tickSpacing))
        expect(liquidity).to.eq(1n)
        expect(feeGrowthInside0LastX128).to.eq(102084710076281216349243831104605583n)
        expect(feeGrowthInside1LastX128).to.eq(10208471007628121634924383110460558n)
        expect(tokensOwed0, 'tokens owed 0 before').to.eq(0n)
        expect(tokensOwed1, 'tokens owed 1 before').to.eq(0n)

        await pool.burn(minTick + tickSpacing, maxTick - tickSpacing, 1n)
        ;({
          liquidity,
          feeGrowthInside0LastX128,
          feeGrowthInside1LastX128,
          tokensOwed1,
          tokensOwed0,
        } = await pool.positions(getPositionKey(wallet.address, minTick + tickSpacing, maxTick - tickSpacing)))
        expect(liquidity).to.eq(0n)
        expect(feeGrowthInside0LastX128).to.eq(102084710076281216349243831104605583n)
        expect(feeGrowthInside1LastX128).to.eq(10208471007628121634924383110460558n)
        expect(tokensOwed0, 'tokens owed 0 after').to.eq(3n)
        expect(tokensOwed1, 'tokens owed 1 after').to.eq(0n)
      })
    })
  })

  describe('#burn', () => {
    beforeEach('initialize at zero tick', () => initializeAtZeroTick(pool))

    async function checkTickIsClear(tick: bigint) {
      const { liquidityGross, feeGrowthOutside0X128, feeGrowthOutside1X128, liquidityNet } = await pool.ticks(tick)
      expect(liquidityGross).to.eq(0n)
      expect(feeGrowthOutside0X128).to.eq(0n)
      expect(feeGrowthOutside1X128).to.eq(0n)
      expect(liquidityNet).to.eq(0n)
    }

    async function checkTickIsNotClear(tick: bigint) {
      const { liquidityGross } = await pool.ticks(tick)
      expect(liquidityGross).to.not.eq(0n)
    }

    it('does not clear the position fee growth snapshot if no more liquidity', async () => {
      // some activity that would make the ticks non-zero
      await pool.advanceTime(10n)
      await mint(other.address, minTick, maxTick, expandTo18Decimals(1))
      await swapExact0For1(expandTo18Decimals(1), wallet.address)
      await swapExact1For0(expandTo18Decimals(1), wallet.address)
      await pool.connect(other).burn(minTick, maxTick, expandTo18Decimals(1))
      const {
        liquidity,
        tokensOwed0,
        tokensOwed1,
        feeGrowthInside0LastX128,
        feeGrowthInside1LastX128,
      } = await pool.positions(getPositionKey(other.address, minTick, maxTick))
      expect(liquidity).to.eq(0n)
      expect(tokensOwed0).to.not.eq(0n)
      expect(tokensOwed1).to.not.eq(0n)
      expect(feeGrowthInside0LastX128).to.eq(340282366920938463463374607431768211n)
      expect(feeGrowthInside1LastX128).to.eq(340282366920938576890830247744589365n)
    })

    it('clears the tick if its the last position using it', async () => {
      const tickLower = minTick + tickSpacing
      const tickUpper = maxTick - tickSpacing
      // some activity that would make the ticks non-zero
      await pool.advanceTime(10n)
      await mint(wallet.address, tickLower, tickUpper, 1n)
      await swapExact0For1(expandTo18Decimals(1), wallet.address)
      await pool.burn(tickLower, tickUpper, 1n)
      await checkTickIsClear(tickLower)
      await checkTickIsClear(tickUpper)
    })

    it('(223) clears only the lower tick if upper is still used', async () => {
      const tickLower = minTick + tickSpacing
      const tickUpper = maxTick - tickSpacing
      // some activity that would make the ticks non-zero
      await pool.advanceTime(10n)
      await mint(wallet.address, tickLower, tickUpper, 1n)
      await mint223(wallet.address, tickLower + tickSpacing, tickUpper, 1n)
      await swapExact0For1(expandTo18Decimals(1), wallet.address)
      await pool.burn(tickLower, tickUpper, 1n)
      await checkTickIsClear(tickLower)
      await checkTickIsNotClear(tickUpper)
    })

    it('(223-20) clears only the upper tick if lower is still used', async () => {
      const tickLower = minTick + tickSpacing
      const tickUpper = maxTick - tickSpacing
      // some activity that would make the ticks non-zero
      await pool.advanceTime(10)
      await mint(wallet.address, tickLower, tickUpper, 1n)
      await mintMixed(wallet.address, tickLower, tickUpper - tickSpacing, 1n)
      await swapExact0For1(expandTo18Decimals(1), wallet.address)
      await pool.burn(tickLower, tickUpper, 1n)
      await checkTickIsNotClear(tickLower)
      await checkTickIsClear(tickUpper)
    })
  })

  // the combined amount of liquidity that the pool is initialized with (including the 1 minimum liquidity that is burned)
  const initializeLiquidityAmount = expandTo18Decimals(2)
  async function initializeAtZeroTick(pool: MockTimeDex223Pool): Promise<void> {
    await pool.initialize(encodePriceSqrt(1n, 1n))
    const tickSpacing = await pool.tickSpacing()
    const [min, max] = [getMinTick(Number(tickSpacing)), getMaxTick(Number(tickSpacing))]
    await mint(wallet.address, min, max, initializeLiquidityAmount)
  }

  describe('#observe', () => {
    beforeEach(() => initializeAtZeroTick(pool))

    // zero tick
    it('current tick accumulator increases by tick over time', async () => {
      let {
        tickCumulatives: [tickCumulative],
      } = await pool.observe([0n])
      expect(tickCumulative).to.eq(0n)
      await pool.advanceTime(10n)
      ;({
        tickCumulatives: [tickCumulative],
      } = await pool.observe([0n]))
      expect(tickCumulative).to.eq(0n)
    })

    it('current tick accumulator after single swap', async () => {
      // moves to tick -1
      await swapExact0For1(1000n, wallet.address)
      await pool.advanceTime(4n)
      let {
        tickCumulatives: [tickCumulative],
      } = await pool.observe([0n])
      expect(tickCumulative).to.eq(-4n)
    })

    it('current tick accumulator after two swaps', async () => {
      await swapExact0For1(expandTo18Decimals(1) / 2n, wallet.address)
      expect((await pool.slot0()).tick).to.eq(-4452n)
      await pool.advanceTime(4n)
      await swapExact1For0(expandTo18Decimals(1) / 4n, wallet.address)
      expect((await pool.slot0()).tick).to.eq(-1558n)
      await pool.advanceTime(6n)
      let {
        tickCumulatives: [tickCumulative],
      } = await pool.observe([0n])
      // -4452*4 + -1558*6
      expect(tickCumulative).to.eq(-27156n)
    })
  })

  describe('miscellaneous mint tests', () => {
    beforeEach('initialize at zero tick', async () => {
      pool = await createPool(FeeAmount.LOW, TICK_SPACINGS[FeeAmount.LOW])
      await initializeAtZeroTick(pool)
    })

    it('mint to the right of the current price', async () => {
      const liquidityDelta = 1000n
      const lowerTick = tickSpacing
      const upperTick = tickSpacing * 2n

      const liquidityBefore = await pool.liquidity()

      const b0 = await token0.balanceOf(pool.target.toString())
      const b1 = await token1.balanceOf(pool.target.toString())

      await mint(wallet.address, lowerTick, upperTick, liquidityDelta)

      const liquidityAfter = await pool.liquidity()
      expect(liquidityAfter).to.be.gte(liquidityBefore)

      expect((await token0.balanceOf(pool.target.toString())) - b0).to.eq(1n)
      expect((await token1.balanceOf(pool.target.toString())) - b1).to.eq(0n)
    })

    it('mint to the left of the current price', async () => {
      const liquidityDelta = 1000n
      const lowerTick = -tickSpacing * 2n
      const upperTick = -tickSpacing

      const liquidityBefore = await pool.liquidity()

      const b0 = await token0.balanceOf(pool.target.toString())
      const b1 = await token1.balanceOf(pool.target.toString())

      await mint(wallet.address, lowerTick, upperTick, liquidityDelta)

      const liquidityAfter = await pool.liquidity()
      expect(liquidityAfter).to.be.gte(liquidityBefore)

      expect((await token0.balanceOf(pool.target.toString())) - b0).to.eq(0n)
      expect((await token1.balanceOf(pool.target.toString())) - b1).to.eq(1n)
    })

    it('mint within the current price', async () => {
      const liquidityDelta = 1000n
      const lowerTick = -tickSpacing
      const upperTick = tickSpacing

      const liquidityBefore = await pool.liquidity()

      const b0 = await token0.balanceOf(pool.target.toString())
      const b1 = await token1.balanceOf(pool.target.toString())

      await mint(wallet.address, lowerTick, upperTick, liquidityDelta)

      const liquidityAfter = await pool.liquidity()
      expect(liquidityAfter).to.be.gte(liquidityBefore)

      expect((await token0.balanceOf(pool.target.toString()))- b0).to.eq(1n)
      expect((await token1.balanceOf(pool.target.toString())) - b1).to.eq(1n)
    })

    it('cannot remove more than the entire position', async () => {
      const lowerTick = -tickSpacing
      const upperTick = tickSpacing
      await mint(wallet.address, lowerTick, upperTick, expandTo18Decimals(1000))
      // should be 'LS', hardhat is bugged
      await expect(pool.burn(lowerTick, upperTick, expandTo18Decimals(1001))).to.be.reverted
    })

    it('collect fees within the current price after swap', async () => {
      const liquidityDelta = expandTo18Decimals(100)
      const lowerTick = -tickSpacing * 100n
      const upperTick = tickSpacing * 100n

      await mint(wallet.address, lowerTick, upperTick, liquidityDelta)

      const liquidityBefore = await pool.liquidity()

      const amount0In = expandTo18Decimals(1)
      await swapExact0For1(amount0In, wallet.address)

      const liquidityAfter = await pool.liquidity()
      expect(liquidityAfter, 'k increases').to.be.gte(liquidityBefore)

      const token0BalanceBeforePool = await token0.balanceOf(pool.target.toString())
      const token1BalanceBeforePool = await token1.balanceOf(pool.target.toString())
      const token0BalanceBeforeWallet = await token0.balanceOf(wallet.address)
      const token1BalanceBeforeWallet = await token1.balanceOf(wallet.address)

      await pool.burn(lowerTick, upperTick, 0)
      await pool.collect(wallet.address, lowerTick, upperTick, MaxUint128, MaxUint128, false, false)

      await pool.burn(lowerTick, upperTick, 0)
      const { amount0: fees0, amount1: fees1 } = await pool.collect.staticCall(
        wallet.address,
        lowerTick,
        upperTick,
        MaxUint128,
        MaxUint128,
          false,
          false
      )
      expect(fees0).to.be.eq(0n)
      expect(fees1).to.be.eq(0n)

      const token0BalanceAfterWallet = await token0.balanceOf(wallet.address)
      const token1BalanceAfterWallet = await token1.balanceOf(wallet.address)
      const token0BalanceAfterPool = await token0.balanceOf(pool.target.toString())
      const token1BalanceAfterPool = await token1.balanceOf(pool.target.toString())

      expect(token0BalanceAfterWallet).to.be.gt(token0BalanceBeforeWallet)
      expect(token1BalanceAfterWallet).to.be.eq(token1BalanceBeforeWallet)

      expect(token0BalanceAfterPool).to.be.lt(token0BalanceBeforePool)
      expect(token1BalanceAfterPool).to.be.eq(token1BalanceBeforePool)
    })

    it('(223) collect fees within the current price after swap', async () => {
      const liquidityDelta = expandTo18Decimals(100)
      const lowerTick = -tickSpacing * 100n
      const upperTick = tickSpacing * 100n

      await mint223(wallet.address, lowerTick, upperTick, liquidityDelta)

      const liquidityBefore = await pool.liquidity()

      const amount0In = expandTo18Decimals(1)
      await swapExact0For1_223(amount0In, wallet.address)

      const liquidityAfter = await pool.liquidity()
      expect(liquidityAfter, 'k increases').to.be.gte(liquidityBefore)

      const token0BalanceBeforePool = await token0_223.balanceOf(pool.target)
      const token1BalanceBeforePool = await token1_223.balanceOf(pool.target)
      const token0BalanceBeforeWallet = await token0_223.balanceOf(wallet.address)
      const token1BalanceBeforeWallet = await token1_223.balanceOf(wallet.address)

      await pool.burn(lowerTick, upperTick, 0)
      // collect in ERC223 - no conversion required
      await pool.collect(wallet.address, lowerTick, upperTick, MaxUint128, MaxUint128, true, true)

      await pool.burn(lowerTick, upperTick, 0)
      const { amount0: fees0, amount1: fees1 } = await pool.collect.staticCall(
        wallet.address,
        lowerTick,
        upperTick,
        MaxUint128,
        MaxUint128,
          false,
          false
      )
      expect(fees0).to.be.eq(0n)
      expect(fees1).to.be.eq(0n)

      const token0BalanceAfterWallet = await token0_223.balanceOf(wallet.address)
      const token1BalanceAfterWallet = await token1_223.balanceOf(wallet.address)
      const token0BalanceAfterPool = await token0_223.balanceOf(pool.target)
      const token1BalanceAfterPool = await token1_223.balanceOf(pool.target)

      expect(token0BalanceAfterWallet).to.be.gt(token0BalanceBeforeWallet)
      expect(token1BalanceAfterWallet).to.be.eq(token1BalanceBeforeWallet)

      expect(token0BalanceAfterPool).to.be.lt(token0BalanceBeforePool)
      expect(token1BalanceAfterPool).to.be.eq(token1BalanceBeforePool)
    })
  })

  describe('post-initialize at medium fee', () => {
    describe('k (implicit)', () => {
      it('returns 0 before initialization', async () => {
        expect(await pool.liquidity()).to.eq(0n)
      })
      describe('post initialized', () => {
        beforeEach(() => initializeAtZeroTick(pool))

        it('returns initial liquidity', async () => {
          expect(await pool.liquidity()).to.eq(expandTo18Decimals(2))
        })
        it('returns in supply in range', async () => {
          await mint(wallet.address, -tickSpacing, tickSpacing, expandTo18Decimals(3))
          expect(await pool.liquidity()).to.eq(expandTo18Decimals(5))
        })
        it('excludes supply at tick above current tick', async () => {
          await mint(wallet.address, tickSpacing, tickSpacing * 2n, expandTo18Decimals(3))
          expect(await pool.liquidity()).to.eq(expandTo18Decimals(2))
        })
        it('excludes supply at tick below current tick', async () => {
          await mint(wallet.address, -tickSpacing * 2n, -tickSpacing, expandTo18Decimals(3))
          expect(await pool.liquidity()).to.eq(expandTo18Decimals(2))
        })
        it('updates correctly when exiting range', async () => {
          const kBefore = await pool.liquidity()
          expect(kBefore).to.be.eq(expandTo18Decimals(2))

          // add liquidity at and above current tick
          const liquidityDelta = expandTo18Decimals(1)
          const lowerTick = 0n
          const upperTick = tickSpacing
          await mint(wallet.address, lowerTick, upperTick, liquidityDelta)

          // ensure virtual supply has increased appropriately
          const kAfter = await pool.liquidity()
          expect(kAfter).to.be.eq(expandTo18Decimals(3))

          // swap toward the left (just enough for the tick transition function to trigger)
          await swapExact0For1(1n, wallet.address)
          const { tick } = await pool.slot0()
          expect(tick).to.be.eq(-1n)

          const kAfterSwap = await pool.liquidity()
          expect(kAfterSwap).to.be.eq(expandTo18Decimals(2))
        })
        it('updates correctly when entering range', async () => {
          const kBefore = await pool.liquidity()
          expect(kBefore).to.be.eq(expandTo18Decimals(2))

          // add liquidity below the current tick
          const liquidityDelta = expandTo18Decimals(1)
          const lowerTick = -tickSpacing
          const upperTick = 0n
          await mint(wallet.address, lowerTick, upperTick, liquidityDelta)

          // ensure virtual supply hasn't changed
          const kAfter = await pool.liquidity()
          expect(kAfter).to.be.eq(kBefore)

          // swap toward the left (just enough for the tick transition function to trigger)
          await swapExact0For1(1n, wallet.address)
          const { tick } = await pool.slot0()
          expect(tick).to.be.eq(-1)

          const kAfterSwap = await pool.liquidity()
          expect(kAfterSwap).to.be.eq(expandTo18Decimals(3))
        })
      })
    })
  })

  describe('limit orders', () => {
    beforeEach('initialize at tick 0', () => initializeAtZeroTick(pool))

    it('limit selling 0 for 1 at tick 0 thru 1', async () => {
      await expect(mint(wallet.address, 0n, 120n, expandTo18Decimals(1)))
        .to.emit(token0, 'Transfer')
        .withArgs(wallet.address, pool.target.toString(), '5981737760509663')
      // somebody takes the limit order
      await swapExact1For0(expandTo18Decimals(2), other.address)
      await expect(pool.burn(0n, 120n, expandTo18Decimals(1)))
        .to.emit(pool, 'Burn')
        .withArgs(wallet.address, 0n, 120n, expandTo18Decimals(1), 0n, '6017734268818165')
        .to.not.emit(token0, 'Transfer')
        .to.not.emit(token1, 'Transfer')
      await expect(pool.collect(wallet.address, 0n, 120n, MaxUint128, MaxUint128, false, false))
        .to.emit(token1, 'Transfer')
        .withArgs(pool.target.toString(), wallet.address, 6017734268818165n + 18107525382602n) // roughly 0.3% despite other liquidity
        .to.not.emit(token0, 'Transfer')
      expect((await pool.slot0()).tick).to.be.gte(120n)
    })

    // NOTE: 223 version
    it('(223) limit selling 0 for 1 at tick 0 thru 1', async () => {
      await expect(mint223(wallet.address, 0n, 120n, expandTo18Decimals(1)))
        .to.emit(token0_223, 'Transfer(address,address,uint256)')
        .withArgs(swapTarget.target, pool.target, '5981737760509663')
      // somebody takes the limit order
      await swapExact1For0_223(expandTo18Decimals(2), other.address)
      await expect(pool.burn(0n, 120n, expandTo18Decimals(1)))
        .to.emit(pool, 'Burn')
        .withArgs(wallet.address, 0n, 120n, expandTo18Decimals(1), 0n, '6017734268818165')
        .to.not.emit(token0_223, 'Transfer(address,address,uint256)')
        .to.not.emit(token1_223, 'Transfer(address,address,uint256)')
      await expect(pool.collect(wallet.address, 0n, 120n, MaxUint128, MaxUint128, true, true))
        .to.emit(token1_223, 'Transfer(address,address,uint256)')
        .withArgs(pool.target, wallet.address, 6017734268818165n + 18107525382602n) // roughly 0.3% despite other liquidity
        .to.not.emit(token0_223, 'Transfer(address,address,uint256)')
      expect((await pool.slot0()).tick).to.be.gte(120n)
    })

    it('limit selling 1 for 0 at tick 0 thru -1', async () => {
      await expect(mint(wallet.address, -120n, 0n, expandTo18Decimals(1)))
        .to.emit(token1, 'Transfer')
        .withArgs(wallet.address, pool.target.toString(), '5981737760509663')
      // somebody takes the limit order
      await swapExact0For1(expandTo18Decimals(2), other.address)
      await expect(pool.burn(-120n, 0n, expandTo18Decimals(1)))
        .to.emit(pool, 'Burn')
        .withArgs(wallet.address, -120n, 0n, expandTo18Decimals(1), '6017734268818165', 0n)
        .to.not.emit(token0, 'Transfer')
        .to.not.emit(token1, 'Transfer')
      await expect(pool.collect(wallet.address, -120n, 0n, MaxUint128, MaxUint128, false, false))
        .to.emit(token0, 'Transfer')
        .withArgs(pool.target.toString(), wallet.address, 6017734268818165n + 18107525382602n) // roughly 0.3% despite other liquidity
      expect((await pool.slot0()).tick).to.be.lt(-120n)
    })

    describe('fee is on', () => {
      beforeEach(() => pool.setFeeProtocol(6n, 6n))

      it('limit selling 0 for 1 at tick 0 thru 1', async () => {
        await expect(mint(wallet.address, 0n, 120n, expandTo18Decimals(1)))
          .to.emit(token0, 'Transfer')
          .withArgs(wallet.address, pool.target.toString(), '5981737760509663')
        // somebody takes the limit order
        await swapExact1For0(expandTo18Decimals(2), other.address)
        await expect(pool.burn(0n, 120n, expandTo18Decimals(1)))
          .to.emit(pool, 'Burn')
          .withArgs(wallet.address, 0n, 120n, expandTo18Decimals(1), 0n, '6017734268818165')
          .to.not.emit(token0, 'Transfer')
          .to.not.emit(token1, 'Transfer')
        await expect(pool.collect(wallet.address, 0n, 120n, MaxUint128, MaxUint128, false, false))
          .to.emit(token1, 'Transfer')
          .withArgs(pool.target.toString(), wallet.address, 6017734268818165n + 15089604485501n) // roughly 0.25% despite other liquidity
          .to.not.emit(token0, 'Transfer')
        expect((await pool.slot0()).tick).to.be.gte(120n)
      })

      // NOTE: 223 version
      it('(223) limit selling 0 for 1 at tick 0 thru 1', async () => {
        await expect(mint223(wallet.address, 0n, 120n, expandTo18Decimals(1)))
          .to.emit(token0_223, 'Transfer(address,address,uint256)')
          .withArgs(swapTarget.target, pool.target, '5981737760509663')
        // somebody takes the limit order
        await swapExact1For0_223(expandTo18Decimals(2), other.address)
        await expect(pool.burn(0n, 120n, expandTo18Decimals(1)))
          .to.emit(pool, 'Burn')
          .withArgs(wallet.address, 0n, 120n, expandTo18Decimals(1), 0n, '6017734268818165')
          .to.not.emit(token0_223, 'Transfer(address,address,uint256)')
          .to.not.emit(token1_223, 'Transfer(address,address,uint256)')
        await expect(pool.collect(wallet.address, 0n, 120n, MaxUint128, MaxUint128, true, true))
          .to.emit(token1_223, 'Transfer(address,address,uint256)')
          .withArgs(pool.target, wallet.address, 6017734268818165n + 15089604485501n) // roughly 0.25% despite other liquidity
          .to.not.emit(token0_223, 'Transfer(address,address,uint256)')
        expect((await pool.slot0()).tick).to.be.gte(120n)
      })

      it('limit selling 1 for 0 at tick 0 thru -1', async () => {
        await expect(mint(wallet.address, -120n, 0n, expandTo18Decimals(1)))
          .to.emit(token1, 'Transfer')
          .withArgs(wallet.address, pool.target.toString(), '5981737760509663')
        // somebody takes the limit order
        await swapExact0For1(expandTo18Decimals(2), other.address)
        await expect(pool.burn(-120n, 0n, expandTo18Decimals(1)))
          .to.emit(pool, 'Burn')
          .withArgs(wallet.address, -120n, 0n, expandTo18Decimals(1), '6017734268818165', 0n)
          .to.not.emit(token0, 'Transfer')
          .to.not.emit(token1, 'Transfer')
        await expect(pool.collect(wallet.address, -120n, 0n, MaxUint128, MaxUint128, false, false))
          .to.emit(token0, 'Transfer')
          .withArgs(pool.target.toString(), wallet.address, 6017734268818165n + 15089604485501n) // roughly 0.25% despite other liquidity
        expect((await pool.slot0()).tick).to.be.lt(-120n)
      })
    })
  })

  describe('#swap', () => {
    beforeEach(async () => {
      pool = await createPool(FeeAmount.MEDIUM, TICK_SPACINGS[FeeAmount.MEDIUM]);
      await pool.initialize(encodePriceSqrt(1n, 1n));
    });

    // NOTE: includes 223 version tokens
    it('(223) exactInputSingle', async () => {
      await mint223(wallet.address, minTick, maxTick, expandTo18Decimals(10));

      await swapExact0For1_223(expandTo18Decimals(1), wallet.address);

      const {liquidity} = await pool.positions(
          getPositionKey(wallet.address, minTick, maxTick)
      );

      expect(liquidity).to.be.eq('10000000000000000000')
    });

    it('(223) exactInputSingle failing deadline', async () => {
      await mint223(wallet.address, minTick, maxTick, expandTo18Decimals(10));

      await expect(swapExact0For1_223(expandTo18Decimals(1), wallet.address, undefined, undefined, 10n)).to.be.reverted;
    });

    it('(223) exactInputSingle failing minimum out', async () => {
      await mint223(wallet.address, minTick, maxTick, expandTo18Decimals(10));

      await expect(swapExact0For1_223(expandTo18Decimals(1), wallet.address, undefined, 906610893880149132n, undefined)).to.be.reverted;
    });

    // NOTE compare direct swap balances (swap 223-223 and swap 20-20)
    // it('(223-223) exactInputSingle balances', async () => {
    //   await mint(wallet.address, minTick, maxTick, expandTo18Decimals(100000));
    //   // await mint223(wallet.address, maxTick - tickSpacing, maxTick, 2n ** 102n);
    //   // await mint223(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, 10000n);
    //   let balances = await Promise.all([
    //       token0.balanceOf(pool.target.toString()),
    //       token1.balanceOf(pool.target.toString()),
    //       token0_223.balanceOf(pool.target.toString()),
    //       token1_223.balanceOf(pool.target.toString()),
    //   ]);
    //   console.log(`Balance 0: ${balances[0]}`);
    //   console.log(`Balance 1: ${balances[1]}`);
    //   console.log(`Balance 0_223: ${balances[2]}`);
    //   console.log(`Balance 1_223: ${balances[3]}`);
    //   await swapExact1For0(expandTo18Decimals(1000) , wallet.address);
    //
    //   let balances1 = await Promise.all([
    //     token0.balanceOf(pool.target.toString()),
    //     token1.balanceOf(pool.target.toString()),
    //     token0_223.balanceOf(pool.target.toString()),
    //     token1_223.balanceOf(pool.target.toString()),
    //   ]);
    //   console.log(`Diff (223) Balance 0: ${balances[0] - balances1[0]}`);
    //   console.log(`Diff (223) Balance 1: ${balances[1] - balances1[1]}`);
    //   console.log(`Diff (223) Balance 0_223: ${balances[2] - balances1[2]}`);
    //   console.log(`Diff (223) Balance 1_223: ${balances[3] - balances1[3]}`);
    //
    //
    //   // NOTE trying to restore pool to init state
    //   // let position = await pool.positions(getPositionKey(wallet.address, minTick, maxTick));
    //   // console.log(`Position: ${position}`);
    //   //
    //   // await pool.burn(minTick, maxTick, position.liquidity);
    //   //
    //   // position = await pool.positions(getPositionKey(wallet.address, minTick, maxTick));
    //   // console.log(`Position after burn: ${position}`);
    //   //
    //   // await pool.collect(
    //   //     wallet.address,
    //   //     minTick,
    //   //     maxTick,
    //   //     balances1[0],
    //   //     balances1[1],
    //   //     false,
    //   //     false
    //   // );
    //   //
    //   // position = await pool.positions(getPositionKey(wallet.address, minTick, maxTick));
    //   // console.log(`Position after collect: ${position}`);
    //   //
    //   // balances = await Promise.all([
    //   //   token0.balanceOf(pool.target.toString()),
    //   //   token1.balanceOf(pool.target.toString()),
    //   //   token0_223.balanceOf(pool.target.toString()),
    //   //   token1_223.balanceOf(pool.target.toString()),
    //   // ]);
    //   // console.log(`Balance 0: ${balances[0]}`);
    //   // console.log(`Balance 1: ${balances[1]}`);
    //   // console.log(`Balance 0_223: ${balances[2]}`);
    //   // console.log(`Balance 1_223: ${balances[3]}`);
    //   //
    //   // await mint223(wallet.address, minTick, maxTick, expandTo18Decimals(100000));
    //   //
    //   // balances = await Promise.all([
    //   //   token0.balanceOf(pool.target.toString()),
    //   //   token1.balanceOf(pool.target.toString()),
    //   //   token0_223.balanceOf(pool.target.toString()),
    //   //   token1_223.balanceOf(pool.target.toString()),
    //   // ]);
    //   // console.log(`Balance 0: ${balances[0]}`);
    //   // console.log(`Balance 1: ${balances[1]}`);
    //   // console.log(`Balance 0_223: ${balances[2]}`);
    //   // console.log(`Balance 1_223: ${balances[3]}`);
    //   //
    //   // await swapExact1For0_223(expandTo18Decimals(1000), wallet.address);
    //   //
    //   // balances1 = await Promise.all([
    //   //   token0.balanceOf(pool.target.toString()),
    //   //   token1.balanceOf(pool.target.toString()),
    //   //   token0_223.balanceOf(pool.target.toString()),
    //   //   token1_223.balanceOf(pool.target.toString()),
    //   // ]);
    //   // console.log(`Diff (20) Balance 0: ${balances[0] - balances1[0]}`);
    //   // console.log(`Diff (20) Balance 1: ${balances[1] - balances1[1]}`);
    //   // console.log(`Diff (20) Balance 0_223: ${balances[2] - balances1[2]}`);
    //   // console.log(`Diff (20) Balance 1_223: ${balances[3] - balances1[3]}`);
    // });

    // it('(20-20) exactInputSingle balances', async () => {
    //   await mint(wallet.address, minTick, maxTick, expandTo18Decimals(100000));
    //   // await mint(wallet.address, maxTick - tickSpacing, maxTick, 2n ** 102n);
    //   // await mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, 10000n);
    //   const balances = await Promise.all([
    //     token0.balanceOf(pool.target.toString()),
    //     token1.balanceOf(pool.target.toString()),
    //     token0_223.balanceOf(pool.target.toString()),
    //     token1_223.balanceOf(pool.target.toString()),
    //   ]);
    //   console.log(`Balance 0: ${balances[0]}`);
    //   console.log(`Balance 1: ${balances[1]}`);
    //   console.log(`Balance 0_223: ${balances[2]}`);
    //   console.log(`Balance 1_223: ${balances[3]}`);
    //   await swapExact1For0(expandTo18Decimals(1000), wallet.address);
    //
    //   const balances1 = await Promise.all([
    //     token0.balanceOf(pool.target.toString()),
    //     token1.balanceOf(pool.target.toString()),
    //     token0_223.balanceOf(pool.target.toString()),
    //     token1_223.balanceOf(pool.target.toString()),
    //   ]);
    //   console.log(`Diff (20) Balance 0: ${balances[0] - balances1[0]}`);
    //   console.log(`Diff (20) Balance 1: ${balances[1] - balances1[1]}`);
    //   console.log(`Diff (20) Balance 0_223: ${balances[2] - balances1[2]}`);
    //   console.log(`Diff (20) Balance 1_223: ${balances[3] - balances1[3]}`);
    // });

  });

  describe('#collect', () => {
    beforeEach(async () => {
      pool = await createPool(FeeAmount.LOW, TICK_SPACINGS[FeeAmount.LOW])
      await pool.initialize(encodePriceSqrt(1n, 1n))
    })

    // NOTE: includes 223 version tokens
    it('(223) works with multiple LPs', async () => {
      await mint(wallet.address, minTick, maxTick, expandTo18Decimals(1))
      await mint223(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, expandTo18Decimals(2))

      await swapExact0For1(expandTo18Decimals(1), wallet.address)

      // poke positions
      await pool.burn(minTick, maxTick, 0n)
      await pool.burn(minTick + tickSpacing, maxTick - tickSpacing, 0n)

      const { tokensOwed0: tokensOwed0Position0 } = await pool.positions(
        getPositionKey(wallet.address, minTick, maxTick)
      )
      const { tokensOwed0: tokensOwed0Position1 } = await pool.positions(
        getPositionKey(wallet.address, minTick + tickSpacing, maxTick - tickSpacing)
      )

      expect(tokensOwed0Position0).to.be.eq('166666666666667')
      expect(tokensOwed0Position1).to.be.eq('333333333333334')
    })

    describe('works across large increases', () => {
      beforeEach(async () => {
        await mint(wallet.address, minTick, maxTick, expandTo18Decimals(1))
      })

      // type(uint128).max * 2**128 / 1e18
      // https://www.wolframalpha.com/input/?i=%282**128+-+1%29+*+2**128+%2F+1e18
      const magicNumber = 115792089237316195423570985008687907852929702298719625575994n

      it('works just before the cap binds', async () => {
        await pool.setFeeGrowthGlobal0X128(magicNumber)
        await pool.burn(minTick, maxTick, 0)

        const { tokensOwed0, tokensOwed1 } = await pool.positions(getPositionKey(wallet.address, minTick, maxTick))

        expect(tokensOwed0).to.be.eq(MaxUint128 - 1n)
        expect(tokensOwed1).to.be.eq(0n)
      })

      it('works just after the cap binds', async () => {
        await pool.setFeeGrowthGlobal0X128(magicNumber + 1n)
        await pool.burn(minTick, maxTick, 0n)

        const { tokensOwed0, tokensOwed1 } = await pool.positions(getPositionKey(wallet.address, minTick, maxTick))

        expect(tokensOwed0).to.be.eq(MaxUint128)
        expect(tokensOwed1).to.be.eq(0n)
      })

      it('works well after the cap binds', async () => {
        await pool.setFeeGrowthGlobal0X128(ethers.MaxUint256)
        await pool.burn(minTick, maxTick, 0n)

        const { tokensOwed0, tokensOwed1 } = await pool.positions(getPositionKey(wallet.address, minTick, maxTick))

        expect(tokensOwed0).to.be.eq(MaxUint128)
        expect(tokensOwed1).to.be.eq(0n)
      })
    })

    describe('works across overflow boundaries', () => {
      beforeEach(async () => {
        await pool.setFeeGrowthGlobal0X128(ethers.MaxUint256)
        await pool.setFeeGrowthGlobal1X128(ethers.MaxUint256)
        await mint(wallet.address, minTick, maxTick, expandTo18Decimals(10))
      })

      it('token0', async () => {
        await swapExact0For1(expandTo18Decimals(1), wallet.address)
        await pool.burn(minTick, maxTick, 0)
        // @ts-ignore
        const { amount0, amount1 } = await pool.collect.staticCall(
          wallet.address,
          minTick,
          maxTick,
          MaxUint128,
          MaxUint128,
            false,
            false
        )
        expect(amount0).to.be.eq(499999999999999n)
        expect(amount1).to.be.eq(0n)
      })
      it('token1', async () => {
        await swapExact1For0(expandTo18Decimals(1), wallet.address)
        await pool.burn(minTick, maxTick, 0n)
        // @ts-ignore
        const { amount0, amount1 } = await pool.collect.staticCall(
          wallet.address,
          minTick,
          maxTick,
          MaxUint128,
          MaxUint128,
            false,
            false
        )
        expect(amount0).to.be.eq(0n)
        expect(amount1).to.be.eq(499999999999999n)
      })
      it('token0 and token1', async () => {
        await swapExact0For1(expandTo18Decimals(1), wallet.address)
        await swapExact1For0(expandTo18Decimals(1), wallet.address)
        await pool.burn(minTick, maxTick, 0n)
        // @ts-ignore
        const { amount0, amount1 } = await pool.collect.staticCall(
          wallet.address,
          minTick,
          maxTick,
          MaxUint128,
          MaxUint128,
            false,
            false
        )
        expect(amount0).to.be.eq(499999999999999n)
        expect(amount1).to.be.eq(500000000000000n)
      })
    })
  })

  describe('#feeProtocol', () => {
    const liquidityAmount = expandTo18Decimals(1000)

    beforeEach(async () => {
      pool = await createPool(FeeAmount.LOW, TICK_SPACINGS[FeeAmount.LOW])
      await pool.initialize(encodePriceSqrt(1n, 1n))
      await mint(wallet.address, minTick, maxTick, liquidityAmount)
    })

    it('is initially set to 0', async () => {
      expect((await pool.slot0()).feeProtocol).to.eq(0n)
    })

    it('can be changed by the owner', async () => {
      await pool.setFeeProtocol(6, 6)
      expect((await pool.slot0()).feeProtocol).to.eq(102n)
    })

    it('cannot be changed out of bounds', async () => {
      await expect(pool.setFeeProtocol(3n, 3n)).to.be.reverted
      await expect(pool.setFeeProtocol(11n, 11n)).to.be.reverted
    })

    it('cannot be changed by addresses that are not owner', async () => {
      await expect(pool.connect(other).setFeeProtocol(6n, 6n)).to.be.reverted
    })

    async function swapAndGetFeesOwed({
      amount,
      zeroForOne,
      poke,
    }: {
      amount: bigint
      zeroForOne: boolean
      poke: boolean
    }) {
      await (zeroForOne ? swapExact0For1(amount, wallet.address) : swapExact1For0(amount, wallet.address))

      if (poke) await pool.burn(minTick, maxTick, 0n)

      const { amount0: fees0, amount1: fees1 } = await pool.collect.staticCall(
        wallet.address,
        minTick,
        maxTick,
        MaxUint128,
        MaxUint128,
          false,
          false
      )

      expect(fees0, 'fees owed in token0 are greater than 0').to.be.gte(0n)
      expect(fees1, 'fees owed in token1 are greater than 0').to.be.gte(0n)

      return { token0Fees: fees0, token1Fees: fees1 }
    }

    it('position owner gets full fees when protocol fee is off', async () => {
      const { token0Fees, token1Fees } = await swapAndGetFeesOwed({
        amount: expandTo18Decimals(1),
        zeroForOne: true,
        poke: true,
      })

      // 6 bips * 1e18
      expect(token0Fees).to.eq(499999999999999n)
      expect(token1Fees).to.eq(0n)
    })

    it('swap fees accumulate as expected (0 for 1)', async () => {
      let token0Fees
      let token1Fees
      ;({ token0Fees, token1Fees } = await swapAndGetFeesOwed({
        amount: expandTo18Decimals(1),
        zeroForOne: true,
        poke: true,
      }))
      expect(token0Fees).to.eq(499999999999999n)
      expect(token1Fees).to.eq(0n)
      ;({ token0Fees, token1Fees } = await swapAndGetFeesOwed({
        amount: expandTo18Decimals(1),
        zeroForOne: true,
        poke: true,
      }))
      expect(token0Fees).to.eq(999999999999998n)
      expect(token1Fees).to.eq(0n)
      ;({ token0Fees, token1Fees } = await swapAndGetFeesOwed({
        amount: expandTo18Decimals(1),
        zeroForOne: true,
        poke: true,
      }))
      expect(token0Fees).to.eq(1499999999999997n)
      expect(token1Fees).to.eq(0n)
    })

    it('swap fees accumulate as expected (1 for 0)', async () => {
      let token0Fees
      let token1Fees
      ;({ token0Fees, token1Fees } = await swapAndGetFeesOwed({
        amount: expandTo18Decimals(1),
        zeroForOne: false,
        poke: true,
      }))
      expect(token0Fees).to.eq(0n)
      expect(token1Fees).to.eq(499999999999999n)
      ;({ token0Fees, token1Fees } = await swapAndGetFeesOwed({
        amount: expandTo18Decimals(1),
        zeroForOne: false,
        poke: true,
      }))
      expect(token0Fees).to.eq(0n)
      expect(token1Fees).to.eq(999999999999998n)
      ;({ token0Fees, token1Fees } = await swapAndGetFeesOwed({
        amount: expandTo18Decimals(1),
        zeroForOne: false,
        poke: true,
      }))
      expect(token0Fees).to.eq(0n)
      expect(token1Fees).to.eq(1499999999999997n)
    })

    it('position owner gets partial fees when protocol fee is on', async () => {
      await pool.setFeeProtocol(6n, 6n)

      const { token0Fees, token1Fees } = await swapAndGetFeesOwed({
        amount: expandTo18Decimals(1),
        zeroForOne: true,
        poke: true,
      })

      expect(token0Fees).to.be.eq(416666666666666n)
      expect(token1Fees).to.be.eq(0n)
    })

    describe('#collectProtocol', () => {
      it('returns 0 if no fees', async () => {
        await pool.setFeeProtocol(6n, 6n)
        // @ts-ignore
        const { amount0, amount1 } = await pool.collectProtocol.staticCall(wallet.address, MaxUint128, MaxUint128, false, false)
        expect(amount0).to.be.eq(0n)
        expect(amount1).to.be.eq(0n)
      });

      it('can collect fees', async () => {
        await pool.setFeeProtocol(6n, 6n)

        await swapAndGetFeesOwed({
          amount: expandTo18Decimals(1),
          zeroForOne: true,
          poke: true,
        })

        await expect(pool.collectProtocol(other.address, MaxUint128, MaxUint128, false, false))
          .to.emit(token0, 'Transfer')
          .withArgs(pool.target.toString(), other.address, 83333333333332n)
      });
      
      it('(erc223) can collect fees', async () => {
        await pool.setFeeProtocol(6n, 6n)

        await swapAndGetFeesOwed({
          amount: expandTo18Decimals(1),
          zeroForOne: true,
          poke: true,
        })

        await expect(pool.collectProtocol(other.address, MaxUint128, MaxUint128, true, true))
            .to.emit(token0_223, 'Transfer(address,address,uint256)')
            .withArgs(pool.target.toString(), other.address, 83333333333332n)
      });

      it('(223-20) fees collected can differ between token0 and token1', async () => {
        await pool.setFeeProtocol(8n, 5n)

        await swapAndGetFeesOwed({
          amount: expandTo18Decimals(1),
          zeroForOne: true,
          poke: false,
        })
        await swapAndGetFeesOwed({
          amount: expandTo18Decimals(1),
          zeroForOne: false,
          poke: false,
        })

        await expect(pool.collectProtocol(other.address, MaxUint128, MaxUint128, true, false))
          // .to.emit(token0, 'Transfer')
            .to.emit(token0_223, 'Transfer(address,address,uint256)')
          // more token0 fees because it's 1/5th the swap fees
          .withArgs(pool.target.toString(), other.address, 62499999999999n)
          .to.emit(token1, 'Transfer')
          // less token1 fees because it's 1/8th the swap fees
          .withArgs(pool.target.toString(), other.address, 99999999999998n)
      })
    })

    it('fees collected by lp after two swaps should be double one swap', async () => {
      await swapAndGetFeesOwed({
        amount: expandTo18Decimals(1),
        zeroForOne: true,
        poke: true,
      })
      const { token0Fees, token1Fees } = await swapAndGetFeesOwed({
        amount: expandTo18Decimals(1),
        zeroForOne: true,
        poke: true,
      })

      // 6 bips * 2e18
      expect(token0Fees).to.eq(999999999999998n)
      expect(token1Fees).to.eq(0n)
    })

    it('fees collected after two swaps with fee turned on in middle are fees from last swap (not confiscatory)', async () => {
      await swapAndGetFeesOwed({
        amount: expandTo18Decimals(1),
        zeroForOne: true,
        poke: false,
      })

      await pool.setFeeProtocol(6n, 6n)

      const { token0Fees, token1Fees } = await swapAndGetFeesOwed({
        amount: expandTo18Decimals(1),
        zeroForOne: true,
        poke: true,
      })

      expect(token0Fees).to.eq(916666666666666n)
      expect(token1Fees).to.eq(0n)
    })

    it('fees collected by lp after two swaps with intermediate withdrawal', async () => {
      await pool.setFeeProtocol(6n, 6n)

      const { token0Fees, token1Fees } = await swapAndGetFeesOwed({
        amount: expandTo18Decimals(1),
        zeroForOne: true,
        poke: true,
      })

      expect(token0Fees).to.eq(416666666666666n)
      expect(token1Fees).to.eq(0n)

      // collect the fees
      await pool.collect(wallet.address, minTick, maxTick, MaxUint128, MaxUint128, false, false)

      const { token0Fees: token0FeesNext, token1Fees: token1FeesNext } = await swapAndGetFeesOwed({
        amount: expandTo18Decimals(1),
        zeroForOne: true,
        poke: false,
      })

      expect(token0FeesNext).to.eq(0n)
      expect(token1FeesNext).to.eq(0n)

      let { token0: token0ProtocolFees, token1: token1ProtocolFees } = await pool.protocolFees()
      expect(token0ProtocolFees).to.eq(166666666666666n)
      expect(token1ProtocolFees).to.eq(0n)

      await pool.burn(minTick, maxTick, 0n) // poke to update fees
      await expect(pool.collect(wallet.address, minTick, maxTick, MaxUint128, MaxUint128, false, false))
        .to.emit(token0, 'Transfer')
        .withArgs(pool.target.toString(), wallet.address, 416666666666666n)
      ;({ token0: token0ProtocolFees, token1: token1ProtocolFees } = await pool.protocolFees())
      expect(token0ProtocolFees).to.eq(166666666666666n)
      expect(token1ProtocolFees).to.eq(0n)
    })
  })

  describe('#tickSpacing', () => {
    describe('tickSpacing = 12', () => {
      beforeEach('deploy pool', async () => {
        pool = await createPool(FeeAmount.MEDIUM, 12)
      })
      describe('post initialize', () => {
        beforeEach('initialize pool', async () => {
          await pool.initialize(encodePriceSqrt(1n, 1n))
        })
        it('mint can only be called for multiples of 12', async () => {
          await expect(mint(wallet.address, -6n, 0n, 1n)).to.be.reverted
          await expect(mint(wallet.address, 0n, 6n, 1n)).to.be.reverted
        })
        it('mint can be called with multiples of 12', async () => {
          await mint(wallet.address, 12n, 24n, 1n)
          await mint(wallet.address, -144n, -120n, 1n)
        })
        it('swapping across gaps works in 1 for 0 direction', async () => {
          const liquidityAmount = expandTo18Decimals(1) / 4n
          await mint(wallet.address, 120000n, 121200n, liquidityAmount)
          await swapExact1For0(expandTo18Decimals(1), wallet.address)
          await expect(pool.burn(120000n, 121200n, liquidityAmount))
            .to.emit(pool, 'Burn')
            .withArgs(wallet.address, 120000n, 121200n, liquidityAmount, 30027458295511n, 996999999999999999n)
            .to.not.emit(token0, 'Transfer')
            .to.not.emit(token1, 'Transfer')
          expect((await pool.slot0()).tick).to.eq(120196n)
        })
        it('swapping across gaps works in 0 for 1 direction', async () => {
          const liquidityAmount = expandTo18Decimals(1) / 4n
          await mint(wallet.address, -121200n, -120000n, liquidityAmount)
          await swapExact0For1(expandTo18Decimals(1), wallet.address)
          await expect(pool.burn(-121200n, -120000n, liquidityAmount))
            .to.emit(pool, 'Burn')
            .withArgs(wallet.address, -121200n, -120000n, liquidityAmount, 996999999999999999n, 30027458295511n)
            .to.not.emit(token0, 'Transfer')
            .to.not.emit(token1, 'Transfer')
          expect((await pool.slot0()).tick).to.eq(-120197n)
        })
      })
    })
  })

  // https://github.com/Uniswap/uniswap-v3-core/issues/214
  it('tick transition cannot run twice if zero for one swap ends at fractional price just below tick', async () => {
    pool = await createPool(FeeAmount.MEDIUM, 1)
    const sqrtTickMath = (await (await ethers.getContractFactory('TickMathTest')).deploy()) as TickMathTest
    const swapMath = (await (await ethers.getContractFactory('SwapMathTest')).deploy()) as SwapMathTest
    const p0 = (await sqrtTickMath.getSqrtRatioAtTick(-24081n)) + 1n
    // initialize at a price of ~0.3 token1/token0
    // meaning if you swap in 2 token0, you should end up getting 0 token1
    await pool.initialize(p0)
    expect(await pool.liquidity(), 'current pool liquidity is 1').to.eq(0n)
    expect((await pool.slot0()).tick, 'pool tick is -24081').to.eq(-24081n)

    // add a bunch of liquidity around current price
    const liquidity = expandTo18Decimals(1000)
    await mint(wallet.address, -24082n, -24080n, liquidity)
    expect(await pool.liquidity(), 'current pool liquidity is now liquidity + 1').to.eq(liquidity)

    await mint(wallet.address, -24082n, -24081n, liquidity)
    expect(await pool.liquidity(), 'current pool liquidity is still liquidity + 1').to.eq(liquidity)

    // check the math works out to moving the price down 1, sending no amount out, and having some amount remaining
    {
      const { feeAmount, amountIn, amountOut, sqrtQ } = await swapMath.computeSwapStep(
        p0,
        p0 - 1n,
        liquidity,
        3,
        FeeAmount.MEDIUM
      )
      expect(sqrtQ, 'price moves').to.eq(p0 - 1n)
      expect(feeAmount, 'fee amount is 1').to.eq(1n)
      expect(amountIn, 'amount in is 1').to.eq(1n)
      expect(amountOut, 'zero amount out').to.eq(0n)
    }

    // swap 2 amount in, should get 0 amount out
    await expect((await swapExact0For1(3n, wallet.address)).wait())
        .to.emit(token0, 'Transfer')
        .withArgs(wallet.address, pool.target.toString(), 3n)
      .to.not.emit(token1, 'Transfer')

    const { tick, sqrtPriceX96 } = await pool.slot0()

    expect(tick, 'pool is at the next tick').to.eq(-24082n)
    expect(sqrtPriceX96, 'pool price is still on the p0 boundary').to.eq(p0 - 1n)
    expect(await pool.liquidity(), 'pool has run tick transition and liquidity changed').to.eq(liquidity * 2n)
  })

  // describe('#flash', () => {
  //   it('fails if not initialized', async () => {
  //     await expect(flash(100, 200, other.address)).to.be.reverted
  //     await expect(flash(100, 0, other.address)).to.be.reverted
  //     await expect(flash(0, 200, other.address)).to.be.reverted
  //   })
  //   it('fails if no liquidity', async () => {
  //     await pool.initialize(encodePriceSqrt(1, 1))
  //     await expect(flash(100, 200, other.address)).to.be.revertedWith('L')
  //     await expect(flash(100, 0, other.address)).to.be.revertedWith('L')
  //     await expect(flash(0, 200, other.address)).to.be.revertedWith('L')
  //   })
  //   describe('after liquidity added', () => {
  //     let balance0: BigNumber
  //     let balance1: BigNumber
  //     beforeEach('add some tokens', async () => {
  //       await initializeAtZeroTick(pool)
  //       ;[balance0, balance1] = await Promise.all([token0.balanceOf(pool.target.toString()), token1.balanceOf(pool.target.toString())])
  //     })
  //
  //     describe('fee off', () => {
  //       it('emits an event', async () => {
  //         await expect(flash(1001, 2001, other.address))
  //           .to.emit(pool, 'Flash')
  //           .withArgs(swapTarget.address, other.address, 1001, 2001, 4, 7)
  //       })
  //
  //       it('transfers the amount0 to the recipient', async () => {
  //         await expect(flash(100, 200, other.address))
  //           .to.emit(token0, 'Transfer')
  //           .withArgs(pool.target.toString(), other.address, 100)
  //       })
  //       it('transfers the amount1 to the recipient', async () => {
  //         await expect(flash(100, 200, other.address))
  //           .to.emit(token1, 'Transfer')
  //           .withArgs(pool.target.toString(), other.address, 200)
  //       })
  //       it('can flash only token0', async () => {
  //         await expect(flash(101, 0, other.address))
  //           .to.emit(token0, 'Transfer')
  //           .withArgs(pool.target.toString(), other.address, 101)
  //           .to.not.emit(token1, 'Transfer')
  //       })
  //       it('can flash only token1', async () => {
  //         await expect(flash(0, 102, other.address))
  //           .to.emit(token1, 'Transfer')
  //           .withArgs(pool.target.toString(), other.address, 102)
  //           .to.not.emit(token0, 'Transfer')
  //       })
  //       it('can flash entire token balance', async () => {
  //         await expect(flash(balance0, balance1, other.address))
  //           .to.emit(token0, 'Transfer')
  //           .withArgs(pool.target.toString(), other.address, balance0)
  //           .to.emit(token1, 'Transfer')
  //           .withArgs(pool.target.toString(), other.address, balance1)
  //       })
  //       it('no-op if both amounts are 0', async () => {
  //         await expect(flash(0, 0, other.address)).to.not.emit(token0, 'Transfer').to.not.emit(token1, 'Transfer')
  //       })
  //       it('fails if flash amount is greater than token balance', async () => {
  //         await expect(flash(balance0.add(1), balance1, other.address)).to.be.reverted
  //         await expect(flash(balance0, balance1.add(1), other.address)).to.be.reverted
  //       })
  //       it('calls the flash callback on the sender with correct fee amounts', async () => {
  //         await expect(flash(1001, 2002, other.address)).to.emit(swapTarget, 'FlashCallback').withArgs(4, 7)
  //       })
  //       it('increases the fee growth by the expected amount', async () => {
  //         await flash(1001, 2002, other.address)
  //         expect(await pool.feeGrowthGlobal0X128()).to.eq(
  //           BigNumber.from(4).mul(BigNumber.from(2).pow(128)).div(expandTo18Decimals(2))
  //         )
  //         expect(await pool.feeGrowthGlobal1X128()).to.eq(
  //           BigNumber.from(7).mul(BigNumber.from(2).pow(128)).div(expandTo18Decimals(2))
  //         )
  //       })
  //       it('fails if original balance not returned in either token', async () => {
  //         await expect(flash(1000, 0, other.address, 999, 0)).to.be.reverted
  //         await expect(flash(0, 1000, other.address, 0, 999)).to.be.reverted
  //       })
  //       it('fails if underpays either token', async () => {
  //         await expect(flash(1000, 0, other.address, 1002, 0)).to.be.reverted
  //         await expect(flash(0, 1000, other.address, 0, 1002)).to.be.reverted
  //       })
  //       it('allows donating token0', async () => {
  //         await expect(flash(0, 0, constants.AddressZero, 567, 0))
  //           .to.emit(token0, 'Transfer')
  //           .withArgs(wallet.address, pool.target.toString(), 567)
  //           .to.not.emit(token1, 'Transfer')
  //         expect(await pool.feeGrowthGlobal0X128()).to.eq(
  //           BigNumber.from(567).mul(BigNumber.from(2).pow(128)).div(expandTo18Decimals(2))
  //         )
  //       })
  //       it('allows donating token1', async () => {
  //         await expect(flash(0, 0, constants.AddressZero, 0, 678))
  //           .to.emit(token1, 'Transfer')
  //           .withArgs(wallet.address, pool.target.toString(), 678)
  //           .to.not.emit(token0, 'Transfer')
  //         expect(await pool.feeGrowthGlobal1X128()).to.eq(
  //           BigNumber.from(678).mul(BigNumber.from(2).pow(128)).div(expandTo18Decimals(2))
  //         )
  //       })
  //       it('allows donating token0 and token1 together', async () => {
  //         await expect(flash(0, 0, constants.AddressZero, 789, 1234))
  //           .to.emit(token0, 'Transfer')
  //           .withArgs(wallet.address, pool.target.toString(), 789)
  //           .to.emit(token1, 'Transfer')
  //           .withArgs(wallet.address, pool.target.toString(), 1234)
  //
  //         expect(await pool.feeGrowthGlobal0X128()).to.eq(
  //           BigNumber.from(789).mul(BigNumber.from(2).pow(128)).div(expandTo18Decimals(2))
  //         )
  //         expect(await pool.feeGrowthGlobal1X128()).to.eq(
  //           BigNumber.from(1234).mul(BigNumber.from(2).pow(128)).div(expandTo18Decimals(2))
  //         )
  //       })
  //     })
  //
  //     describe('fee on', () => {
  //       beforeEach('turn protocol fee on', async () => {
  //         await pool.setFeeProtocol(6, 6)
  //       })
  //
  //       it('emits an event', async () => {
  //         await expect(flash(1001, 2001, other.address))
  //           .to.emit(pool, 'Flash')
  //           .withArgs(swapTarget.address, other.address, 1001, 2001, 4, 7)
  //       })
  //
  //       it('increases the fee growth by the expected amount', async () => {
  //         await flash(2002, 4004, other.address)
  //
  //         const { token0: token0ProtocolFees, token1: token1ProtocolFees } = await pool.protocolFees()
  //         expect(token0ProtocolFees).to.eq(1)
  //         expect(token1ProtocolFees).to.eq(2)
  //
  //         expect(await pool.feeGrowthGlobal0X128()).to.eq(
  //           BigNumber.from(6).mul(BigNumber.from(2).pow(128)).div(expandTo18Decimals(2))
  //         )
  //         expect(await pool.feeGrowthGlobal1X128()).to.eq(
  //           BigNumber.from(11).mul(BigNumber.from(2).pow(128)).div(expandTo18Decimals(2))
  //         )
  //       })
  //       it('allows donating token0', async () => {
  //         await expect(flash(0, 0, constants.AddressZero, 567, 0))
  //           .to.emit(token0, 'Transfer')
  //           .withArgs(wallet.address, pool.target.toString(), 567)
  //           .to.not.emit(token1, 'Transfer')
  //
  //         const { token0: token0ProtocolFees } = await pool.protocolFees()
  //         expect(token0ProtocolFees).to.eq(94)
  //
  //         expect(await pool.feeGrowthGlobal0X128()).to.eq(
  //           BigNumber.from(473).mul(BigNumber.from(2).pow(128)).div(expandTo18Decimals(2))
  //         )
  //       })
  //       it('allows donating token1', async () => {
  //         await expect(flash(0, 0, constants.AddressZero, 0, 678))
  //           .to.emit(token1, 'Transfer')
  //           .withArgs(wallet.address, pool.target.toString(), 678)
  //           .to.not.emit(token0, 'Transfer')
  //
  //         const { token1: token1ProtocolFees } = await pool.protocolFees()
  //         expect(token1ProtocolFees).to.eq(113)
  //
  //         expect(await pool.feeGrowthGlobal1X128()).to.eq(
  //           BigNumber.from(565).mul(BigNumber.from(2).pow(128)).div(expandTo18Decimals(2))
  //         )
  //       })
  //       it('allows donating token0 and token1 together', async () => {
  //         await expect(flash(0, 0, constants.AddressZero, 789, 1234))
  //           .to.emit(token0, 'Transfer')
  //           .withArgs(wallet.address, pool.target.toString(), 789)
  //           .to.emit(token1, 'Transfer')
  //           .withArgs(wallet.address, pool.target.toString(), 1234)
  //
  //         const { token0: token0ProtocolFees, token1: token1ProtocolFees } = await pool.protocolFees()
  //         expect(token0ProtocolFees).to.eq(131)
  //         expect(token1ProtocolFees).to.eq(205)
  //
  //         expect(await pool.feeGrowthGlobal0X128()).to.eq(
  //           BigNumber.from(658).mul(BigNumber.from(2).pow(128)).div(expandTo18Decimals(2))
  //         )
  //         expect(await pool.feeGrowthGlobal1X128()).to.eq(
  //           BigNumber.from(1029).mul(BigNumber.from(2).pow(128)).div(expandTo18Decimals(2))
  //         )
  //       })
  //     })
  //   })
  // })

  describe('#increaseObservationCardinalityNext', () => {
    it('cannot be called before initialization', async () => {
      await expect(pool.increaseObservationCardinalityNext(2n)).to.be.reverted
    })
    describe('after initialization', () => {
      beforeEach('initialize the pool', () => pool.initialize(encodePriceSqrt(1n, 1n)))
      it('oracle starting state after initialization', async () => {
        const { observationCardinality, observationIndex, observationCardinalityNext } = await pool.slot0()
        expect(observationCardinality).to.eq(1n)
        expect(observationIndex).to.eq(0n)
        expect(observationCardinalityNext).to.eq(1n)
        const {
          secondsPerLiquidityCumulativeX128,
          tickCumulative,
          initialized,
          blockTimestamp,
        } = await pool.observations(0n)
        expect(secondsPerLiquidityCumulativeX128).to.eq(0n)
        expect(tickCumulative).to.eq(0n)
        expect(initialized).to.eq(true)
        expect(blockTimestamp).to.eq(TEST_POOL_START_TIME)
      })
      it('increases observation cardinality next', async () => {
        await pool.increaseObservationCardinalityNext(2n)
        const { observationCardinality, observationIndex, observationCardinalityNext } = await pool.slot0()
        expect(observationCardinality).to.eq(1n)
        expect(observationIndex).to.eq(0n)
        expect(observationCardinalityNext).to.eq(2n)
      })
      it('is no op if target is already exceeded', async () => {
        await pool.increaseObservationCardinalityNext(5n)
        await pool.increaseObservationCardinalityNext(3n)
        const { observationCardinality, observationIndex, observationCardinalityNext } = await pool.slot0()
        expect(observationCardinality).to.eq(1n)
        expect(observationIndex).to.eq(0n)
        expect(observationCardinalityNext).to.eq(5n)
      })
    })
  })

  // describe('#setFeeProtocol', () => {
  //   beforeEach('initialize the pool', async () => {
  //     await pool.initialize(encodePriceSqrt(1n, 1n))
  //   })
  //
  //   it('can only be called by factory owner', async () => {
  //     // TODO
  //     await expect(pool.connect(other).setFeeProtocol(5n, 5n)).to.be.reverted
  //   })
  //   it('fails if fee is lt 4 or gt 10', async () => {
  //     // TODO
  //     await expect(pool.setFeeProtocol(3n, 3n)).to.be.reverted
  //     await expect(pool.setFeeProtocol(6n, 3n)).to.be.reverted
  //     await expect(pool.setFeeProtocol(3n, 6n)).to.be.reverted
  //     await expect(pool.setFeeProtocol(11n, 11n)).to.be.reverted
  //     await expect(pool.setFeeProtocol(6n, 11n)).to.be.reverted
  //     await expect(pool.setFeeProtocol(11n, 6n)).to.be.reverted
  //   })
  //   it('succeeds for fee of 4', async () => {
  //     await pool.setFeeProtocol(4n, 4n)
  //   })
  //   it('succeeds for fee of 10', async () => {
  //     await pool.setFeeProtocol(10n, 10n)
  //   })
  //   it('sets protocol fee', async () => {
  //     await pool.setFeeProtocol(7, 7)
  //     expect((await pool.slot0()).feeProtocol).to.eq(119)
  //   })
  //   it('can change protocol fee', async () => {
  //     await pool.setFeeProtocol(7, 7)
  //     await pool.setFeeProtocol(5, 8)
  //     expect((await pool.slot0()).feeProtocol).to.eq(133)
  //   })
  //   it('can turn off protocol fee', async () => {
  //     await pool.setFeeProtocol(4, 4)
  //     await pool.setFeeProtocol(0, 0)
  //     expect((await pool.slot0()).feeProtocol).to.eq(0)
  //   })
  //   it('emits an event when turned on', async () => {
  //     await expect(pool.setFeeProtocol(7, 7)).to.be.emit(pool, 'SetFeeProtocol').withArgs(0, 0, 7, 7)
  //   })
  //   it('emits an event when turned off', async () => {
  //     await pool.setFeeProtocol(7, 5)
  //     await expect(pool.setFeeProtocol(0, 0)).to.be.emit(pool, 'SetFeeProtocol').withArgs(7, 5, 0, 0)
  //   })
  //   it('emits an event when changed', async () => {
  //     await pool.setFeeProtocol(4, 10)
  //     await expect(pool.setFeeProtocol(6, 8)).to.be.emit(pool, 'SetFeeProtocol').withArgs(4, 10, 6, 8)
  //   })
  //   it('emits an event when unchanged', async () => {
  //     await pool.setFeeProtocol(5, 9)
  //     await expect(pool.setFeeProtocol(5, 9)).to.be.emit(pool, 'SetFeeProtocol').withArgs(5, 9, 5, 9)
  //   })
  // })

  describe('#lock', () => {
    beforeEach('initialize the pool', async () => {
      await pool.initialize(encodePriceSqrt(1n, 1n))
      await mint(wallet.address, minTick, maxTick, expandTo18Decimals(1))
    })

    // TODO lock in delegate swap (?) - disabled
    // it('cannot reenter from swap callback', async () => {
    //   const reentrant = (await (
    //     await ethers.getContractFactory('TestUniswapV3ReentrantCallee')
    //   ).deploy()) as TestUniswapV3ReentrantCallee
    //
    //   // the tests happen in solidity
    //
    //   // const res = await (await reentrant.swapToReenter(pool.target.toString())).wait()
    //   // console.dir(res)
    //
    //   await expect(reentrant.swapToReenter(pool.target.toString())).to.be.reverted //With('Unable to reenter')
    // })
  })

  describe('#snapshotCumulativesInside', () => {
    const tickLower = BigInt(-TICK_SPACINGS[FeeAmount.MEDIUM])
    const tickUpper = BigInt(TICK_SPACINGS[FeeAmount.MEDIUM])
    const tickSpacing = BigInt(TICK_SPACINGS[FeeAmount.MEDIUM])
    beforeEach(async () => {
      await pool.initialize(encodePriceSqrt(1n, 1n))
      await mint(wallet.address, tickLower, tickUpper, 10n)
    })
    it('throws if ticks are in reverse order', async () => {
      await expect(pool.snapshotCumulativesInside(tickUpper, tickLower)).to.be.reverted
    })
    it('throws if ticks are the same', async () => {
      await expect(pool.snapshotCumulativesInside(tickUpper, tickUpper)).to.be.reverted
    })
    it('throws if tick lower is too low', async () => {
      await expect(pool.snapshotCumulativesInside(getMinTick(Number(tickSpacing)) - 1n, tickUpper)).be.reverted
    })
    it('throws if tick upper is too high', async () => {
      await expect(pool.snapshotCumulativesInside(tickLower, getMaxTick(Number(tickSpacing)) + 1n)).be.reverted
    })
    it('throws if tick lower is not initialized', async () => {
      await expect(pool.snapshotCumulativesInside(tickLower - tickSpacing, tickUpper)).to.be.reverted
    })
    it('throws if tick upper is not initialized', async () => {
      await expect(pool.snapshotCumulativesInside(tickLower, tickUpper + tickSpacing)).to.be.reverted
    })
    it('is zero immediately after initialize', async () => {
      const {
        secondsPerLiquidityInsideX128,
        tickCumulativeInside,
        secondsInside,
      } = await pool.snapshotCumulativesInside(tickLower, tickUpper)
      expect(secondsPerLiquidityInsideX128).to.eq(0n)
      expect(tickCumulativeInside).to.eq(0n)
      expect(secondsInside).to.eq(0n)
    })
    it('increases by expected amount when time elapses in the range', async () => {
      await pool.advanceTime(5n)
      const {
        secondsPerLiquidityInsideX128,
        tickCumulativeInside,
        secondsInside,
      } = await pool.snapshotCumulativesInside(tickLower, tickUpper)
      expect(secondsPerLiquidityInsideX128).to.eq(5n * 2n ** 128n / 10n)
      expect(tickCumulativeInside, 'tickCumulativeInside').to.eq(0n)
      expect(secondsInside).to.eq(5n)
    })
    it('does not account for time increase above range', async () => {
      await pool.advanceTime(5n)
      await swapToHigherPrice(encodePriceSqrt(2n, 1n), wallet.address)
      await pool.advanceTime(7n)
      const {
        secondsPerLiquidityInsideX128,
        tickCumulativeInside,
        secondsInside,
      } = await pool.snapshotCumulativesInside(tickLower, tickUpper)
      expect(secondsPerLiquidityInsideX128).to.eq(5n * 2n ** 128n / 10n)
      expect(tickCumulativeInside, 'tickCumulativeInside').to.eq(0n)
      expect(secondsInside).to.eq(5n)
    })
    it('does not account for time increase below range', async () => {
      await pool.advanceTime(5n)
      await swapToLowerPrice(encodePriceSqrt(1n, 2n), wallet.address)
      await pool.advanceTime(7n)
      const {
        secondsPerLiquidityInsideX128,
        tickCumulativeInside,
        secondsInside,
      } = await pool.snapshotCumulativesInside(tickLower, tickUpper)
      expect(secondsPerLiquidityInsideX128).to.eq(5n * 2n ** 128n / 10n)
      // tick is 0 for 5 seconds, then not in range
      expect(tickCumulativeInside, 'tickCumulativeInside').to.eq(0n)
      expect(secondsInside).to.eq(5n)
    })
    it('time increase below range is not counted', async () => {
      await swapToLowerPrice(encodePriceSqrt(1n, 2n), wallet.address)
      await pool.advanceTime(5n)
      await swapToHigherPrice(encodePriceSqrt(1n, 1n), wallet.address)
      await pool.advanceTime(7n)
      const {
        secondsPerLiquidityInsideX128,
        tickCumulativeInside,
        secondsInside,
      } = await pool.snapshotCumulativesInside(tickLower, tickUpper)
      expect(secondsPerLiquidityInsideX128).to.eq(7n * 2n ** 128n / 10n)
      // tick is not in range then tick is 0 for 7 seconds
      expect(tickCumulativeInside, 'tickCumulativeInside').to.eq(0n)
      expect(secondsInside).to.eq(7n)
    })
    it('time increase above range is not counted', async () => {
      await swapToHigherPrice(encodePriceSqrt(2n, 1n), wallet.address)
      await pool.advanceTime(5n)
      await swapToLowerPrice(encodePriceSqrt(1n, 1n), wallet.address)
      await pool.advanceTime(7n)
      const {
        secondsPerLiquidityInsideX128,
        tickCumulativeInside,
        secondsInside,
      } = await pool.snapshotCumulativesInside(tickLower, tickUpper)
      expect(secondsPerLiquidityInsideX128).to.eq(7n * 2n ** 128n / 10n)
      expect((await pool.slot0()).tick).to.eq(-1n) // justify the -7 tick cumulative inside value
      expect(tickCumulativeInside, 'tickCumulativeInside').to.eq(-7n)
      expect(secondsInside).to.eq(7n)
    })
    it('positions minted after time spent', async () => {
      await pool.advanceTime(5n)
      await mint(wallet.address, tickUpper, getMaxTick(Number(tickSpacing)), 15n)
      await swapToHigherPrice(encodePriceSqrt(2n, 1n), wallet.address)
      await pool.advanceTime(8n)
      const {
        secondsPerLiquidityInsideX128,
        tickCumulativeInside,
        secondsInside,
      } = await pool.snapshotCumulativesInside(tickUpper, getMaxTick(Number(tickSpacing)))
      expect(secondsPerLiquidityInsideX128).to.eq(8n * 2n ** 128n / 15n)
      // the tick of 2/1 is 6931
      // 8 seconds * 6931 = 55448
      expect(tickCumulativeInside, 'tickCumulativeInside').to.eq(55448n)
      expect(secondsInside).to.eq(8n)
    })
    it('overlapping liquidity is aggregated', async () => {
      await mint(wallet.address, tickLower, getMaxTick(Number(tickSpacing)), 15n)
      await pool.advanceTime(5n)
      await swapToHigherPrice(encodePriceSqrt(2n, 1n), wallet.address)
      await pool.advanceTime(8n)
      const {
        secondsPerLiquidityInsideX128,
        tickCumulativeInside,
        secondsInside,
      } = await pool.snapshotCumulativesInside(tickLower, tickUpper)
      expect(secondsPerLiquidityInsideX128).to.eq(5n * 2n ** 128n / 25n)
      expect(tickCumulativeInside, 'tickCumulativeInside').to.eq(0n)
      expect(secondsInside).to.eq(5n)
    })
    it('relative behavior of snapshots', async () => {
      await pool.advanceTime(5n)
      await mint(wallet.address, getMinTick(Number(tickSpacing)), tickLower, 15n)
      const {
        secondsPerLiquidityInsideX128: secondsPerLiquidityInsideX128Start,
        tickCumulativeInside: tickCumulativeInsideStart,
        secondsInside: secondsInsideStart,
      } = await pool.snapshotCumulativesInside(getMinTick(Number(tickSpacing)), tickLower)
      await pool.advanceTime(8n)
      // 13 seconds in starting range, then 3 seconds in newly minted range
      await swapToLowerPrice(encodePriceSqrt(1n, 2n), wallet.address)
      await pool.advanceTime(3n)
      const {
        secondsPerLiquidityInsideX128,
        tickCumulativeInside,
        secondsInside,
      } = await pool.snapshotCumulativesInside(getMinTick(Number(tickSpacing)), tickLower)
      const expectedDiffSecondsPerLiquidity = 3n * 2n ** 128n / 15n
      expect(secondsPerLiquidityInsideX128 - secondsPerLiquidityInsideX128Start).to.eq(
        expectedDiffSecondsPerLiquidity
      )
      expect(secondsPerLiquidityInsideX128).to.not.eq(expectedDiffSecondsPerLiquidity)
      // the tick is the one corresponding to the price of 1/2, or log base 1.0001 of 0.5
      // this is -6932, and 3 seconds have passed, so the cumulative computed from the diff equals 6932 * 3
      expect(tickCumulativeInside - tickCumulativeInsideStart, 'tickCumulativeInside').to.eq(-20796n)
      expect(secondsInside - secondsInsideStart).to.eq(3n)
      expect(secondsInside).to.not.eq(3n)
    })
  })

  // NOTE flash swaps disabled
  // describe('fees overflow scenarios', async () => {
  //   it('up to max uint 128', async () => {
  //     await pool.initialize(encodePriceSqrt(1n, 1n))
  //     await mint(wallet.address, minTick, maxTick, 1n)
  //     // await flash(0, 0, wallet.address, MaxUint128, MaxUint128)
  //
  //     const [feeGrowthGlobal0X128, feeGrowthGlobal1X128] = await Promise.all([
  //       pool.feeGrowthGlobal0X128(),
  //       pool.feeGrowthGlobal1X128(),
  //     ])
  //     // all 1s in first 128 bits
  //     expect(feeGrowthGlobal0X128).to.eq(MaxUint128 * 2n ** 128n)
  //     expect(feeGrowthGlobal1X128).to.eq(MaxUint128 * 2n ** 128n)
  //     await pool.burn(minTick, maxTick, 0n)
  //     const { amount0, amount1 } = await pool.collect.staticCall(
  //       wallet.address,
  //       minTick,
  //       maxTick,
  //       MaxUint128,
  //       MaxUint128,
  //         false,
  //         false
  //     )
  //     expect(amount0).to.eq(MaxUint128)
  //     expect(amount1).to.eq(MaxUint128)
  //   })
  //
  //   it('overflow max uint 128', async () => {
  //     await pool.initialize(encodePriceSqrt(1n, 1n))
  //     await mint(wallet.address, minTick, maxTick, 1n)
  //     // await flash(0, 0, wallet.address, MaxUint128, MaxUint128)
  //     // await flash(0, 0, wallet.address, 1, 1)
  //
  //     const [feeGrowthGlobal0X128, feeGrowthGlobal1X128] = await Promise.all([
  //       pool.feeGrowthGlobal0X128(),
  //       pool.feeGrowthGlobal1X128(),
  //     ])
  //     // all 1s in first 128 bits
  //     expect(feeGrowthGlobal0X128).to.eq(0n)
  //     expect(feeGrowthGlobal1X128).to.eq(0n)
  //     await pool.burn(minTick, maxTick, 0)
  //
  //     const { amount0, amount1 } = await pool.collect.staticCall(
  //       wallet.address,
  //       minTick,
  //       maxTick,
  //       MaxUint128,
  //       MaxUint128, false, false
  //     )
  //     // fees burned
  //     expect(amount0).to.eq(0n)
  //     expect(amount1).to.eq(0n)
  //   })
  //
  //   it('overflow max uint 128 after poke burns fees owed to 0', async () => {
  //     await pool.initialize(encodePriceSqrt(1n, 1n))
  //     await mint(wallet.address, minTick, maxTick, 1n)
  //     // await flash(0, 0, wallet.address, MaxUint128, MaxUint128)
  //     await pool.burn(minTick, maxTick, 0n)
  //     // await flash(0, 0, wallet.address, 1, 1)
  //     await pool.burn(minTick, maxTick, 0n)
  //
  //     const { amount0, amount1 } = await pool.collect.staticCall(
  //       wallet.address,
  //       minTick,
  //       maxTick,
  //       MaxUint128,
  //       MaxUint128, false, false
  //     )
  //     // fees burned
  //     expect(amount0).to.eq(0n)
  //     expect(amount1).to.eq(0n)
  //   })
  //
  //   it('two positions at the same snapshot', async () => {
  //     await pool.initialize(encodePriceSqrt(1n, 1n))
  //     await mint(wallet.address, minTick, maxTick, 1n)
  //     await mint(other.address, minTick, maxTick, 1n)
  //     // await flash(0, 0, wallet.address, MaxUint128, 0)
  //     // await flash(0, 0, wallet.address, MaxUint128, 0)
  //     const feeGrowthGlobal0X128 = await pool.feeGrowthGlobal0X128()
  //     expect(feeGrowthGlobal0X128).to.eq(MaxUint128 * 2n ** 128n)
  //     // await flash(0, 0, wallet.address, 2, 0)
  //     await pool.burn(minTick, maxTick, 0n)
  //     await pool.connect(other).burn(minTick, maxTick, 0n)
  //
  //     let { amount0 } = await pool.collect.staticCall(wallet.address, minTick, maxTick, MaxUint128, MaxUint128, false, false)
  //     expect(amount0, 'amount0 of wallet').to.eq(0n)
  //     ;({ amount0 } = await pool
  //       .connect(other)
  //         // @ts-ignore
  //       .collect.staticCall(other.address, minTick, maxTick, MaxUint128, MaxUint128))
  //     expect(amount0, 'amount0 of other').to.eq(0n)
  //   })
  //
  //   it('two positions 1 wei of fees apart overflows exactly once', async () => {
  //     await pool.initialize(encodePriceSqrt(1n, 1n))
  //     await mint(wallet.address, minTick, maxTick, 1n)
  //     // await flash(0, 0, wallet.address, 1, 0n)
  //     await mint(other.address, minTick, maxTick, 1n)
  //     // await flash(0, 0, wallet.address, MaxUint128, 0)
  //     // await flash(0, 0, wallet.address, MaxUint128, 0)
  //     const feeGrowthGlobal0X128 = await pool.feeGrowthGlobal0X128()
  //     expect(feeGrowthGlobal0X128).to.eq(0n)
  //     // await flash(0, 0, wallet.address, 2, 0)
  //     await pool.burn(minTick, maxTick, 0n)
  //     await pool.connect(other).burn(minTick, maxTick, 0n)
  //
  //     let { amount0 } = await pool.collect.staticCall(wallet.address, minTick, maxTick, MaxUint128, MaxUint128, false, false)
  //     expect(amount0, 'amount0 of wallet').to.eq(1n)
  //     ;({ amount0 } = await pool
  //       .connect(other)
  //         // @ts-ignore
  //       .collect.staticCall(other.address, minTick, maxTick, MaxUint128, MaxUint128))
  //     expect(amount0, 'amount0 of other').to.eq(0n)
  //   })
  // })

  describe('swap underpayment tests', () => {
    let underpay: TestUniswapV3SwapPay
    beforeEach('deploy swap test', async () => {
      const underpayFactory = await ethers.getContractFactory('TestUniswapV3SwapPay')
      underpay = (await underpayFactory.deploy()) as TestUniswapV3SwapPay
      await token0.approve(underpay.target.toString(), ethers.MaxUint256)
      await token1.approve(underpay.target.toString(), ethers.MaxUint256)
      await pool.initialize(encodePriceSqrt(1n, 1n))
      await mint(wallet.address, minTick, maxTick, expandTo18Decimals(1))
    })

    // TODO erc223 version ?

    it('underpay zero for one and exact in', async () => {
      await expect( underpay.swap(pool.target.toString(), wallet.address, true, MIN_SQRT_RATIO + (1n), 1000n, 1n, 0n)
      ).to.be.revertedWith('IIA')
    })
    it('pay in the wrong token zero for one and exact in', async () => {
      await expect( underpay.swap(pool.target.toString(), wallet.address, true, MIN_SQRT_RATIO + (1n), 1000n, 0n, 2000n)
      ).to.be.revertedWith('IIA')
    })
    it('overpay zero for one and exact in', async () => {
      await expect( underpay.swap(pool.target.toString(), wallet.address, true, MIN_SQRT_RATIO + (1n), 1000n, 2000n, 0n)
      ).to.not.be.revertedWith('IIA')
    })
    it('underpay zero for one and exact out', async () => {
      await expect( underpay.swap(pool.target.toString(), wallet.address, true, MIN_SQRT_RATIO + (1n), -1000n, 1n, 0n)
      ).to.be.revertedWith('IIA')
    })
    it('pay in the wrong token zero for one and exact out', async () => {
      await expect( underpay.swap(pool.target.toString(), wallet.address, true, MIN_SQRT_RATIO + (1n), -1000n, 0n, 2000n)
      ).to.be.revertedWith('IIA')
    })
    it('overpay zero for one and exact out', async () => {
      await expect( underpay.swap(pool.target.toString(), wallet.address, true, MIN_SQRT_RATIO + (1n), -1000n, 2000n, 0n)
      ).to.not.be.revertedWith('IIA')
    })
    it('underpay one for zero and exact in', async () => {
      await expect( underpay.swap(pool.target.toString(), wallet.address, false, MAX_SQRT_RATIO - (1n), 1000n, 0n, 1n)
      ).to.be.revertedWith('IIA')
    })
    it('pay in the wrong token one for zero and exact in', async () => {
      await expect( underpay.swap(pool.target.toString(), wallet.address, false, MAX_SQRT_RATIO - (1n), 1000n, 2000n, 0n)
      ).to.be.revertedWith('IIA')
    })
    it('overpay one for zero and exact in', async () => {
      await expect( underpay.swap(pool.target.toString(), wallet.address, false, MAX_SQRT_RATIO - (1n), 1000n, 0n, 2000n)
      ).to.not.be.revertedWith('IIA')
    })
    it('underpay one for zero and exact out', async () => {
      await expect( underpay.swap(pool.target.toString(), wallet.address, false, MAX_SQRT_RATIO - (1n), -1000n, 0n, 1n)
      ).to.be.revertedWith('IIA')
    })
    it('pay in the wrong token one for zero and exact out', async () => {
      await expect( underpay.swap(pool.target.toString(), wallet.address, false, MAX_SQRT_RATIO - (1n), -1000n, 2000n, 0n)
      ).to.be.revertedWith('IIA')
    })
    it('overpay one for zero and exact out', async () => {
      await expect( underpay.swap(pool.target.toString(), wallet.address, false, MAX_SQRT_RATIO - (1n), -1000n, 0n, 2000n)
      ).to.not.be.revertedWith('IIA')
    })
  })
})
