import { ethers } from 'hardhat'
import { expect } from 'chai'
import { time, mine } from '@nomicfoundation/hardhat-network-helpers'

// Audit PoCs: what a stolen RevenueV2 owner key, a stolen ProtocolFeeCollector owner key, or a wrong
// deployment can do to RevenueV2 stakers. Each test states the worst case it pins.
describe('Audit: compromised owner / deployment (RevenueV2)', () => {
  const DAY = 24 * 60 * 60
  const WEEK = 7 * DAY
  const E18 = 10n ** 18n
  const LOCK = 10 * DAY
  const MAX = (1n << 256n) - 1n
  const BLOCK_GAS_LIMIT = 30_000_000n

  async function deploy(minStake = E18) {
    const signers = await ethers.getSigners()
    const [owner, attacker] = signers
    const d223 = await (await ethers.getContractFactory('D223Token')).deploy()
    const d20 = await (await ethers.getContractFactory('TestERC20')).deploy(0n)
    const revenue = await (await ethers.getContractFactory('RevenueV2')).deploy(d20.target, d223.target, WEEK, LOCK, minStake)
    const stake = async (s: any, amount: bigint) => {
      await d20.mint(s.address, amount)
      await d20.connect(s).approve(revenue.target, amount)
      return revenue.connect(s).stake(d20.target, amount)
    }
    const newToken = async () => (await ethers.getContractFactory('HostileERC20')).deploy(18)
    return { signers, owner, attacker, d223, d20, revenue, stake, newToken }
  }

  describe('1. stolen RevenueV2 owner key', () => {
    it('SAFE: cannot sweep staked principal, unstaked ERC-223 deposits or listed rewards (received or synced)', async () => {
      const { signers, owner, attacker, d223, d20, revenue, stake, newToken } = await deploy()
      const [alice, bob] = [signers[2], signers[3]]
      const weth = await newToken()
      await revenue.add_reward_token(weth.target)
      await stake(alice, 1000n * E18)
      await d223['transfer(address,uint256)'](bob.address, 50n * E18)
      await d223.connect(bob)['transfer(address,uint256)'](revenue.target, 50n * E18) // unstaked deposit
      await weth.mint(revenue.target, 10n * E18) // fees received, not yet synced
      await revenue.sync([weth.target])
      await weth.mint(revenue.target, 5n * E18) // fees received after the sync

      for (const [t, a] of [[d20.target, 1n], [d223.target, 1n], [weth.target, 1n]] as const) {
        await expect(revenue.connect(owner).sweep(t, attacker.address, a)).to.be.reverted
      }
      // Ownership change does not help: same function set.
      await revenue.transfer_ownership(attacker.address)
      await revenue.connect(attacker).accept_ownership()
      await expect(revenue.connect(attacker).sweep(weth.target, attacker.address, 1n)).to.be.revertedWith('Reward tokens cannot be swept')
      await expect(revenue.connect(attacker).sweep(d20.target, attacker.address, 1n)).to.be.revertedWith('Only surplus staking tokens can be swept')
      await expect(revenue.connect(attacker).sweep(d223.target, attacker.address, 1n)).to.be.revertedWith('Only surplus staking tokens can be swept')

      await time.increase(LOCK)
      await revenue.connect(alice).withdraw(d20.target, 1000n * E18)
      await revenue.connect(bob).withdrawDeposit(d223.target)
      await revenue.connect(alice).claim([weth.target])
      expect(await d20.balanceOf(alice.address)).to.eq(1000n * E18)
      expect(await d223.balanceOf(bob.address)).to.eq(50n * E18)
    })

    it('CONFIRMED (design): fee revenue in an unlisted token, or in the staking token itself, belongs to the owner', async () => {
      const { attacker, d20, revenue, stake, newToken, signers } = await deploy()
      const alice = signers[2]
      await stake(alice, 1000n * E18)
      // ProtocolFeeCollector sends every pool's fees here. Only listed tokens (max 20) are streamed.
      const usdc = await newToken() // fees for a token the owner has not listed yet
      await usdc.mint(revenue.target, 1_000_000n * E18)
      // D223/X pools pay their D223-side fees in the ERC-20 version = staking_token_erc20. It is never a reward.
      await d20.mint(revenue.target, 777n * E18)
      await expect(revenue.add_reward_token(d20.target)).to.be.revertedWith('Staking token cannot be a reward token')

      // A stolen key front-runs add_reward_token(usdc) and takes everything that accumulated.
      await revenue.sweep(usdc.target, attacker.address, 1_000_000n * E18)
      await revenue.sweep(d20.target, attacker.address, 777n * E18)
      expect(await usdc.balanceOf(attacker.address)).to.eq(1_000_000n * E18)
      expect(await d20.balanceOf(attacker.address)).to.eq(777n * E18)
      // Principal is untouched.
      expect(await revenue.total_staked()).to.eq(1000n * E18)
      expect(await d20.balanceOf(revenue.target)).to.eq(1000n * E18)
    })

    it('CONFIRMED (liveness): one listed token whose balanceOf reverts makes syncAll() revert for every token', async () => {
      const { revenue, stake, newToken, signers, d20 } = await deploy()
      const alice = signers[2]
      const weth = await newToken()
      await revenue.add_reward_token(weth.target)
      // Any contract without balanceOf (here: another RevenueV2) can be listed.
      const junk = await (await ethers.getContractFactory('RevenueV2')).deploy(d20.target, weth.target, WEEK, LOCK, 1n)
      await revenue.add_reward_token(junk.target)
      await stake(alice, 100n * E18)
      await weth.mint(revenue.target, 10n * E18)
      await expect(revenue.syncAll()).to.be.reverted // scripts/fee-keeper.ts only ever calls syncAll()
      // Workaround exists: per-token sync, and stake/withdraw never touch reward tokens.
      await revenue.sync([weth.target])
      await time.increase(LOCK)
      await revenue.connect(alice).withdraw(d20.target, 100n * E18)
      await revenue.connect(alice).claim([weth.target])
      expect(await weth.balanceOf(alice.address)).to.be.gt(9n * E18)
      await expect(revenue.connect(alice).claim([junk.target])).to.be.reverted
    })

    it('THEORETICAL -> CONFIRMED with a tiny min_stake: a hostile listed token can brick stake AND withdraw for everyone', async () => {
      // A listed token whose balance reads as ~2^256 makes each sync queue 1e68 scaled units. Accrual then
      // computes amount * 1e18 / total_staked; with total_staked of 1 wei that overflows mulDiv, and every
      // stake/withdraw walks every listed token in _checkpoint. Principal is frozen with no recovery path.
      const { revenue, stake, newToken, signers, d20 } = await deploy(1n)
      const alice = signers[2]
      await stake(alice, 1n)
      const hostile = await newToken()
      await revenue.add_reward_token(hostile.target)
      await hostile.mint(revenue.target, MAX)
      await revenue.sync([hostile.target]) // permissionless
      await time.increase(LOCK)
      await expect(revenue.connect(alice).withdraw(d20.target, 1n)).to.be.reverted
      await d20.mint(alice.address, 10n ** 30n)
      await d20.connect(alice).approve(revenue.target, 10n ** 30n)
      await expect(revenue.connect(alice).stake(d20.target, 10n ** 30n)).to.be.reverted // cannot dilute out either
    })

    it('SAFE at the deployed min_stake (1e18): the same hostile token cannot brick withdraw even after 200 inflating syncs', async () => {
      const { revenue, stake, newToken, signers, d20 } = await deploy(E18)
      const alice = signers[2]
      await stake(alice, E18) // smallest possible total_staked
      const hostile = await newToken()
      await revenue.add_reward_token(hostile.target)
      await hostile.mint(revenue.target, MAX)
      for (let i = 0; i < 200; i++) await revenue.sync([hostile.target])
      await time.increase(LOCK)
      await revenue.connect(alice).withdraw(d20.target, E18)
      expect(await d20.balanceOf(alice.address)).to.eq(E18)
    })

    it('CONFIRMED (bounded): lock powers - no effect on existing locks; a scheduled 90-day lock applies to any later top-up', async () => {
      const { revenue, stake, signers, d20 } = await deploy()
      const alice = signers[2]
      await stake(alice, 100n * E18)
      await revenue.set_claim_delay(90 * DAY)
      expect(await revenue.unlock_time(alice.address)).to.be.lt((await time.latest()) + LOCK + 10)
      await time.increase(WEEK)
      await stake(alice, E18) // a 1-token top-up after the notice re-locks the whole position for 90 days
      await time.increase(LOCK)
      await expect(revenue.connect(alice).withdraw(d20.target, 1n)).to.be.revertedWith(
        'Tokens are frozen for a specified duration after the last staking',
      )
      await time.increase(90 * DAY)
      await revenue.connect(alice).withdraw(d20.target, 101n * E18)
      await expect(revenue.set_claim_delay(90 * DAY + 1)).to.be.revertedWith('Claim delay too long')
    })

    it('MEASURED: worst-case gas with 20 adversarial listed tokens and heavily populated state', async () => {
      const { revenue, stake, newToken, signers, d20 } = await deploy()
      const users = signers.slice(2, 18)
      const victim = signers[18]
      // The victim stakes before any token is listed, so every per-token user slot is cold and zero.
      await stake(victim, 1000n * E18)
      const tokens: any[] = []
      for (let i = 0; i < 20; i++) {
        const t = await newToken()
        await revenue.add_reward_token(t.target)
        tokens.push(t)
      }
      const addrs = tokens.map((t) => t.target)
      for (const u of users) await stake(u, 10n * E18)
      // Every token: a running stream plus a queue large enough to fold a fresh stream on the next checkpoint,
      // with absurd (maximum) balances so every arithmetic path is at its widest.
      for (const t of tokens) await t.mint(revenue.target, MAX / 2n)
      await revenue.syncAll()
      await time.increase(DAY)
      for (const t of tokens) await t.mint(revenue.target, MAX / 4n)
      await revenue.syncAll()
      await revenue.syncAll()
      await time.increase(LOCK)
      await mine(1)

      const g: Record<string, bigint> = {}
      g.withdraw = (await (await revenue.connect(victim).withdraw(d20.target, 500n * E18)).wait())!.gasUsed
      await time.increase(DAY)
      for (const t of tokens) await t.mint(revenue.target, 10n ** 40n)
      g.syncAll = (await (await revenue.syncAll()).wait())!.gasUsed
      await d20.mint(victim.address, E18)
      await d20.connect(victim).approve(revenue.target, E18)
      g.stake = (await (await revenue.connect(victim).stake(d20.target, E18)).wait())!.gasUsed
      g.claim20 = (await (await revenue.connect(users[0]).claim(addrs)).wait())!.gasUsed
      console.log('      gas', Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v.toString()])))
      for (const v of Object.values(g)) expect(v).to.be.lt(BLOCK_GAS_LIMIT / 10n)
    })
  })

  describe('2. stolen ProtocolFeeCollector owner key', () => {
    it('SAFE: execute() into RevenueV2 has no privilege unless RevenueV2 ownership was handed to the collector', async () => {
      const { revenue, stake, newToken, signers, d20 } = await deploy()
      const [owner, attacker, alice] = signers
      const weth = await newToken()
      await revenue.add_reward_token(weth.target)
      await stake(alice, 100n * E18)
      const Collector = await ethers.getContractFactory('ProtocolFeeCollector')
      const collector: any = await Collector.deploy(owner.address /* dummy factory */, revenue.target, attacker.address, 4, 4)
      const iface = revenue.interface
      await expect(collector.connect(attacker).execute(revenue.target, 0, iface.encodeFunctionData('sweep', [d20.target, attacker.address, 1n]))).to.be.revertedWith('Owner error')
      await expect(collector.connect(attacker).execute(revenue.target, 0, iface.encodeFunctionData('add_reward_token', [d20.target]))).to.be.revertedWith('Owner error')
      // Permissionless calls only do what anyone could do.
      await collector.connect(attacker).execute(revenue.target, 0, iface.encodeFunctionData('syncAll'))
      // Redirecting future fees is the real power.
      await collector.connect(attacker).setRevenue(attacker.address)
      expect(await collector.revenue()).to.eq(attacker.address)

      // Integration hazard: if RevenueV2 ownership is ever moved to the collector, its owner inherits it.
      await revenue.transfer_ownership(collector.target)
      await collector.connect(attacker).execute(revenue.target, 0, iface.encodeFunctionData('accept_ownership'))
      const junk = await newToken()
      await junk.mint(revenue.target, 5n)
      await collector.connect(attacker).execute(revenue.target, 0, iface.encodeFunctionData('sweep', [junk.target, attacker.address, 5n]))
      expect(await junk.balanceOf(attacker.address)).to.eq(5n)
    })
  })

  describe('5. deployment mistakes', () => {
    it('CONFIRMED: swapped staking-token args deploy fine; real D223 ERC-223 deposits then bounce', async () => {
      const { d223, d20 } = await deploy()
      const swapped = await (await ethers.getContractFactory('RevenueV2')).deploy(d223.target, d20.target, WEEK, LOCK, E18)
      await expect(d223['transfer(address,uint256)'](swapped.target, E18)).to.be.revertedWith('Only the ERC-223 staking token is accepted')
    })
  })
})
