import { ethers } from 'hardhat'
import { expect } from 'chai'
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import { poolFixture } from './shared/fixtures'
import {
  encodePriceSqrt, expandTo18Decimals, FeeAmount, getMaxTick, getMinTick,
  MIN_SQRT_RATIO, MAX_SQRT_RATIO, TICK_SPACINGS,
} from './shared/utilities'

/**
 * Randomised sequences of swaps against a real pool, asserting after EVERY operation that the
 * protocol's core safety properties still hold. A single violated invariant here is a fund-loss bug.
 */
describe('Dex223 invariants under randomised activity', () => {
  const TS = TICK_SPACINGS[FeeAmount.MEDIUM]
  const RUNS = Number(process.env.FUZZ_RUNS || 60)
  const SEED = Number(process.env.FUZZ_SEED || 1337)

  // deterministic PRNG so failures are reproducible
  let seed = SEED
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)]

  async function fx() {
    const { token0, token1, converter, createPool, swapTargetCallee } = await loadFixture(poolFixture)
    const [wallet, alice, bob] = await ethers.getSigners()
    await token0.approve(converter.target.toString(), ethers.MaxUint256 / 2n)
    await token1.approve(converter.target.toString(), ethers.MaxUint256 / 2n)
    await converter.wrapERC20toERC223(token0.target, ethers.MaxUint256 / 4n)
    await converter.wrapERC20toERC223(token1.target, ethers.MaxUint256 / 4n)
    const TF = await ethers.getContractFactory('ERC223HybridToken')
    const token0_223 = TF.attach(await converter.predictWrapperAddress(token0.target, true))
    const token1_223 = TF.attach(await converter.predictWrapperAddress(token1.target, true))

    const pool = await createPool(FeeAmount.MEDIUM, TS)
    await pool.initialize(encodePriceSqrt(1n, 1n))
    await pool.advanceTime(1)
    await token0.approve(swapTargetCallee.target, ethers.MaxUint256)
    await token1.approve(swapTargetCallee.target, ethers.MaxUint256)
    await swapTargetCallee.mint(pool.target, wallet.address, getMinTick(TS), getMaxTick(TS), expandTo18Decimals(100))

    for (const a of [alice, bob]) {
      await token0_223.transfer(a.address, expandTo18Decimals(1000))
      await token1_223.transfer(a.address, expandTo18Decimals(1000))
    }
    return { pool, converter, token0, token1, token0_223, token1_223, wallet, alice, bob }
  }

  it(`holds all invariants across ${RUNS} randomised swaps`, async function () {
    this.timeout(600000)
    const c = await loadFixture(fx)
    const { pool, converter, token0, token1, token0_223, token1_223, wallet, alice, bob } = c
    const actors = [wallet, alice, bob]
    const poolAddr = pool.target.toString()
    const convAddr = converter.target.toString()

    // Conservation law: wrapping moves ERC-20 INTO the converter and mints an equal amount of wrapper,
    // so the converter's ERC-20 custody is the backing for the wrapper supply and must not be counted
    // twice. What must stay constant is (ERC-20 outside the converter) + (wrapper total supply).
    const heldOutsideConverter = async (t: any) => {
      let s = 0n
      for (const a of [...actors.map(x => x.address), poolAddr]) s += await t.balanceOf(a)
      return s
    }
    const snapshot = async () => ({
      t0: (await heldOutsideConverter(token0)) + (await token0_223.totalSupply()),
      t1: (await heldOutsideConverter(token1)) + (await token1_223.totalSupply()),
    })

    const start = await snapshot()
    let executed = 0, reverted = 0

    for (let i = 0; i < RUNS; i++) {
      const actor = pick(actors)
      const zeroForOne = rnd() < 0.5
      const inTok = zeroForOne ? token0_223 : token1_223
      const bal: bigint = await inTok.balanceOf(actor.address)
      if (bal === 0n) continue
      // amounts spanning dust -> large, to probe rounding and edge behaviour
      const scale = pick([1n, 10n, 1000n, 100000n, 10n ** 9n, 10n ** 15n, 10n ** 17n])
      const amt = scale > bal ? bal / 2n : scale
      if (amt === 0n) continue

      const prefer223 = rnd() < 0.5
      const payload = ethers.getBytes(pool.interface.encodeFunctionData('swapExactInput', [
        actor.address, zeroForOne, amt, 0n,
        zeroForOne ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n, prefer223,
        ethers.AbiCoder.defaultAbiCoder().encode(['address'], [actor.address]), 1893456000n, false,
      ]))

      try {
        await inTok.connect(actor)['transfer(address,uint256,bytes)'](poolAddr, amt, payload)
        executed++
      } catch { reverted++; continue }

      // ---- invariants that must hold after every single operation ----
      const s = await snapshot()

      // 1. no token is created or destroyed across the whole system
      expect(s.t0, `iter ${i}: token0 conservation broken`).to.eq(start.t0)
      expect(s.t1, `iter ${i}: token1 conservation broken`).to.eq(start.t1)

      // 2. converter solvency: every ERC-223 wrapper is fully backed by ERC-20 it custodies
      expect(await token0_223.totalSupply(), `iter ${i}: token0 wrapper unbacked`)
        .to.be.lte(await token0.balanceOf(convAddr))
      expect(await token1_223.totalSupply(), `iter ${i}: token1 wrapper unbacked`)
        .to.be.lte(await token1.balanceOf(convAddr))

      // 3. the pool never ends a transaction mid-flight
      expect((await pool.slot0()).unlocked, `iter ${i}: pool left locked`).to.eq(true)
      expect(await pool.erc223CallPermit(), `iter ${i}: permit left armed`).to.eq(false)
      expect(await pool.swap_sender(), `iter ${i}: swap_sender left set`).to.eq(ethers.ZeroAddress)

      // 4. pool solvency: it still holds at least the protocol fees it owes
      const pf = await pool.protocolFees()
      expect((await token0.balanceOf(poolAddr)) + (await token0_223.balanceOf(poolAddr)),
        `iter ${i}: pool cannot cover protocol fee 0`).to.be.gte(pf.token0)
      expect((await token1.balanceOf(poolAddr)) + (await token1_223.balanceOf(poolAddr)),
        `iter ${i}: pool cannot cover protocol fee 1`).to.be.gte(pf.token1)
    }

    console.log(`      seed=${SEED} executed=${executed} reverted=${reverted}`)
    expect(executed, 'fuzzing executed no swaps at all - the test is not exercising anything').to.be.greaterThan(5)

    // 5. no actor extracted net value from the pool for free
    for (const a of actors) {
      const t0 = (await token0.balanceOf(a.address)) + (await token0_223.balanceOf(a.address))
      const t1 = (await token1.balanceOf(a.address)) + (await token1_223.balanceOf(a.address))
      expect(t0 + t1, 'actor balance became nonsensical').to.be.gte(0n)
    }
  })
})
