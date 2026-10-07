import { ethers, network } from 'hardhat'
import { expect } from 'chai'
import { time, loadFixture } from '@nomicfoundation/hardhat-network-helpers'

// Hostile audit of RevenueV2 aimed only at staked principal and unstaked ERC-223 deposits.
// "CONFIRMED" tests demonstrate a real loss/freeze path; "SAFE" tests pin that an attack fails.
describe('Audit: RevenueV2 principal', function () {
  this.timeout(300_000)
  const DAY = 24 * 60 * 60
  const WEEK = 7 * DAY
  const E18 = 10n ** 18n
  const LOCK = 10 * DAY
  const MIN_STAKE = E18

  async function fixture() {
    const signers = await ethers.getSigners()
    const [owner, alice, bob, carol, mallory] = signers
    const d223 = await (await ethers.getContractFactory('D223Token')).deploy()
    const d20 = await (await ethers.getContractFactory('TestERC20')).deploy(0n)
    const reward = await (await ethers.getContractFactory('HostileERC20')).deploy(18)
    const revenue = await (await ethers.getContractFactory('RevenueV2')).deploy(d20.target, d223.target, WEEK, LOCK, MIN_STAKE)
    await revenue.add_reward_token(reward.target)
    for (const s of [alice, bob, carol, mallory]) await d223['transfer(address,uint256)'](s.address, 1_000_000n * E18)

    const stake20 = async (s: any, amount: bigint) => {
      await d20.mint(s.address, amount)
      await d20.connect(s).approve(revenue.target, amount)
      return revenue.connect(s).stake(d20.target, amount)
    }
    const stake223 = async (s: any, amount: bigint) => {
      await d223.connect(s)['transfer(address,uint256)'](revenue.target, amount)
      return revenue.connect(s).stake(d223.target, amount)
    }
    return { owner, alice, bob, carol, mallory, d223, d20, reward, revenue, stake20, stake223 }
  }

  // ------------------------------------------------------------------ CONFIRMED

  it('CONFIRMED: draining the ERC-20 side freezes a staker that cannot receive ERC-223 callbacks', async () => {
    const { mallory, d20, d223, revenue, stake223 } = await loadFixture(fixture)
    // Victim: an ERC-20-only integrator (vault/timelock/7702 delegate) with no tokenReceived and no fallback.
    const victim = await (await ethers.getContractFactory('NoCallbackStaker')).deploy()
    await d20.mint(victim.target, 500n * E18)
    await victim.stake(revenue.target, d20.target, 500n * E18)

    // Attacker stakes the ERC-223 version and, after the lock, withdraws in the ERC-20 version: a free
    // 223->20 conversion that empties the ERC-20 balance backing the victim.
    await stake223(mallory, 500n * E18)
    await time.increase(LOCK)
    await revenue.connect(mallory).withdraw(d20.target, 500n * E18)
    expect(await d20.balanceOf(revenue.target)).to.eq(0n)

    // The victim's only payout path is now D223.transfer -> victim.tokenReceived, which does not exist.
    await expect(victim.withdraw(revenue.target, d20.target, 500n * E18)).to.be.reverted
    await expect(victim.withdraw(revenue.target, d223.target, 500n * E18)).to.be.reverted
    // Partial withdrawals do not help either: nothing of the ERC-20 version is left.
    await expect(victim.withdraw(revenue.target, d20.target, 1n * E18)).to.be.reverted
    expect(await revenue.staked(victim.target)).to.eq(500n * E18)
    // The freeze lasts until someone stakes fresh ERC-20 tokens (or the owner never sweeps them away).
    // The owner can also cause it: sweep() of ERC-20 is allowed whenever the 223 side holds surplus.
  })

  it('CONFIRMED: D223 sent to RevenueV2 from inside a RevenueV2 callback is silently swallowed and sweepable', async () => {
    const { owner, d223, revenue } = await loadFixture(fixture)
    const vault = await (await ethers.getContractFactory('ForwardingVault')).deploy(revenue.target, d223.target)
    await d223['transfer(address,uint256)'](vault.target, 100n * E18)
    // Vault deposits by transfer (from its own context): credited normally.
    await network.provider.send('hardhat_impersonateAccount', [vault.target])
    await network.provider.send('hardhat_setBalance', [vault.target, '0x56BC75E2D63100000'])
    const vs = await ethers.getSigner(vault.target as string)
    await d223.connect(vs)['transfer(address,uint256)'](revenue.target, 100n * E18)
    await network.provider.send('hardhat_stopImpersonatingAccount', [vault.target])
    await vault.stakeFromDeposit(100n * E18)
    await time.increase(LOCK)

    // Withdraw: RevenueV2 (locked) pays D223 -> vault.tokenReceived re-deposits it -> RevenueV2.tokenReceived
    // sees locked == true and skips the credit, but still accepts the tokens.
    await vault.withdraw(100n * E18)
    expect(await revenue.staked(vault.target)).to.eq(0n)
    expect(await revenue.erc223deposit(vault.target, d223.target)).to.eq(0n) // never credited
    expect(await d223.balanceOf(revenue.target)).to.eq(100n * E18)           // but held
    await expect(vault.stakeFromDeposit(100n * E18)).to.be.reverted          // vault cannot recover it

    // The owner can take the user's 100 D223 as "surplus".
    await revenue.sweep(d223.target, owner.address, 100n * E18)
    expect(await d223.balanceOf(revenue.target)).to.eq(0n)
  })

  // ---------------------------------------------------------------------- SAFE

  it('SAFE: every re-entry from the D223 tokenReceived callback during withdraw/withdrawDeposit reverts', async () => {
    const { d223, reward, revenue } = await loadFixture(fixture)
    const r = await (await ethers.getContractFactory('ReentrantStaker')).deploy(revenue.target, d223.target, reward.target)
    await d223['transfer(address,uint256)'](r.target, 1000n * E18)
    await r.deposit(600n * E18)
    await r.stakeDeposit(500n * E18) // 100 stays as deposit
    await time.increase(LOCK)
    const reason = revenue.interface.encodeErrorResult('Error', ['Reentrancy error'])
    for (const mode of [1, 2, 3, 4, 5, 6]) {
      await r.setMode(mode)
      await r.withdraw(d223.target, 1n * E18)
      expect(await r.reentryOk()).to.eq(false)
      expect(await r.reentryErr()).to.eq(reason)
    }
    await r.setMode(4)
    await r.withdrawDeposit()
    expect(await r.reentryOk()).to.eq(false)
    expect(await revenue.staked(r.target)).to.eq(494n * E18)
    expect(await revenue.total_erc223_deposits()).to.eq(0n)
  })

  it('SAFE: no over-withdraw, no withdrawing others, deposits cannot be consumed by others', async () => {
    const { alice, bob, mallory, d20, d223, revenue, stake20 } = await loadFixture(fixture)
    await stake20(alice, 100n * E18)
    await d223.connect(bob)['transfer(address,uint256)'](revenue.target, 50n * E18) // bob's unstaked deposit
    await time.increase(LOCK)
    await expect(revenue.connect(alice).withdraw(d20.target, 100n * E18 + 1n)).to.be.revertedWith('Withdrawing more than staked')
    await expect(revenue.connect(mallory).withdraw(d20.target, 1n)).to.be.revertedWith('Withdrawing more than staked')
    // Mallory cannot stake from Bob's deposit (keyed by msg.sender) - falls to transferFrom and fails.
    await expect(revenue.connect(mallory).stake(d223.target, 50n * E18)).to.be.reverted
    await expect(revenue.connect(mallory).withdrawDeposit(d223.target)).to.be.revertedWith('Nothing deposited')
    // withdrawDeposit with an arbitrary token address cannot reach anything.
    await expect(revenue.connect(bob).withdrawDeposit(d20.target)).to.be.revertedWith('Nothing deposited')
    // Below-minimum remainder blocked, but a full exit always works.
    await expect(revenue.connect(alice).withdraw(d20.target, 100n * E18 - 1n)).to.be.revertedWith('Remaining stake below minimum')
    await revenue.connect(alice).withdraw(d20.target, 100n * E18)
    expect(await revenue.erc223deposit(bob.address, d223.target)).to.eq(50n * E18)
  })

  it('SAFE: cross-version withdraw never dips into unstaked deposits', async () => {
    const { alice, bob, carol, d20, d223, revenue, stake20, stake223 } = await loadFixture(fixture)
    await stake20(alice, 100n * E18)
    await stake223(carol, 100n * E18)
    await d223.connect(bob)['transfer(address,uint256)'](revenue.target, 50n * E18)
    await time.increase(LOCK)
    await revenue.connect(carol).withdraw(d20.target, 100n * E18) // carol takes all ERC-20
    await revenue.connect(alice).withdraw(d20.target, 100n * E18) // alice is paid in 223
    expect(await d223.balanceOf(alice.address)).to.eq(1_000_000n * E18 + 100n * E18)
    expect(await d223.balanceOf(revenue.target)).to.eq(50n * E18)
    await revenue.connect(bob).withdrawDeposit(d223.target)
    expect(await d223.balanceOf(revenue.target)).to.eq(0n)
  })

  it('SAFE: sweep cannot take stakes or deposits in either version', async () => {
    const { owner, alice, bob, d20, d223, revenue, stake20, stake223 } = await loadFixture(fixture)
    await stake20(alice, 100n * E18)
    await stake223(bob, 100n * E18)
    await d223.connect(bob)['transfer(address,uint256)'](revenue.target, 30n * E18)
    await expect(revenue.sweep(d20.target, owner.address, 1n)).to.be.revertedWith('Only surplus staking tokens can be swept')
    await expect(revenue.sweep(d223.target, owner.address, 1n)).to.be.revertedWith('Only surplus staking tokens can be swept')
    // Surplus via transferFrom-style donation (no callback) is sweepable, but not one wei more.
    await d20.mint(revenue.target, 10n * E18)
    await expect(revenue.sweep(d223.target, owner.address, 10n * E18 + 1n)).to.be.reverted
    await revenue.sweep(d223.target, owner.address, 10n * E18) // takes 223, surplus sits in 20: still fully backed
    await time.increase(LOCK)
    await revenue.connect(bob).withdrawDeposit(d223.target)
    await revenue.connect(bob).withdraw(d223.target, 100n * E18)
    await revenue.connect(alice).withdraw(d223.target, 100n * E18)
    expect(await revenue.total_staked()).to.eq(0n)
  })

  it('SAFE: staking tokens cannot be listed; tokenReceived cannot be spoofed; D223 with msg.value bounces', async () => {
    const { owner, mallory, d20, d223, revenue } = await loadFixture(fixture)
    await expect(revenue.add_reward_token(d20.target)).to.be.revertedWith('Staking token cannot be a reward token')
    await expect(revenue.add_reward_token(d223.target)).to.be.revertedWith('Staking token cannot be a reward token')
    await expect(revenue.connect(mallory).tokenReceived(mallory.address, 10n ** 30n, '0x')).to.be.revertedWith(
      'Only the ERC-223 staking token is accepted',
    )
    await expect(d223['transfer(address,uint256)'](revenue.target, E18, { value: 1n })).to.be.reverted
    expect(await revenue.erc223deposit(owner.address, d223.target)).to.eq(0n)
  })

  it('SAFE: nobody can extend another user\'s lock or stake on their behalf', async () => {
    const { alice, mallory, d20, d223, revenue, stake20 } = await loadFixture(fixture)
    await stake20(alice, 100n * E18)
    const unlock = await revenue.unlock_time(alice.address)
    await time.increase(LOCK - 100)
    // A D223 "gift" credits the sender, never alice.
    await d223.connect(mallory)['transfer(address,uint256)'](revenue.target, 100n * E18)
    await revenue.connect(mallory).stake(d223.target, 100n * E18)
    expect(await revenue.unlock_time(alice.address)).to.eq(unlock)
    expect(await revenue.erc223deposit(alice.address, d223.target)).to.eq(0n)
    // Owner raising the delay does not touch existing positions.
    await revenue.set_claim_delay(90 * DAY)
    await time.increase(8 * DAY)
    expect(await revenue.unlock_time(alice.address)).to.eq(unlock)
    await revenue.connect(alice).withdraw(d20.target, 100n * E18)
  })

  it('SAFE: hostile listed reward tokens (revert, infinite gas, return bomb, inflating) cannot touch principal', async () => {
    const { owner, alice, d20, revenue, stake20 } = await loadFixture(fixture)
    const F = await ethers.getContractFactory('EvilRewardToken')
    const evil = []
    for (const m of [1, 2, 3, 4]) {
      const t = await F.deploy()
      await revenue.add_reward_token(t.target)
      evil.push({ t, m })
    }
    await stake20(alice, 100n * E18)
    for (const { t, m } of evil) await t.setMode(m)
    const inflating = evil[3].t
    await inflating.bump(10n ** 70n)
    await revenue.sync([inflating.target]) // capped at MAX_SYNC per call
    expect((await revenue.reward_data(inflating.target)).accounted).to.eq(10n ** 50n)
    await expect(revenue.syncAll()).to.be.reverted // one bad token blocks syncAll, not principal
    await expect(revenue.claim([evil[0].t.target])).to.be.reverted
    await time.increase(LOCK)
    await revenue.connect(alice).withdraw(d20.target, 100n * E18, { gasLimit: 2_000_000 })
    expect(await d20.balanceOf(alice.address)).to.eq(100n * E18)
    expect(await revenue.total_staked()).to.eq(0n)
    void owner
  })

  it('GAS: withdraw/stake with 20 live reward streams stays far below the block limit', async () => {
    const { alice, bob, d20, reward, revenue, stake20 } = await loadFixture(fixture)
    const H = await ethers.getContractFactory('HostileERC20')
    const toks = [reward]
    for (let i = 0; i < 19; i++) {
      const t = await H.deploy(i % 2 ? 6 : 18)
      await revenue.add_reward_token(t.target)
      toks.push(t)
    }
    await expect(revenue.add_reward_token((await H.deploy(18)).target)).to.be.revertedWith('Too many reward tokens')
    await stake20(bob, 1000n * E18)
    for (const t of toks) await t.mint(revenue.target, 10n ** 24n)
    await revenue.syncAll()
    await time.increase(DAY)
    // alice is a brand-new account: cold paid/owed slots for all 20 tokens (worst case).
    await d20.mint(alice.address, 100n * E18)
    await d20.connect(alice).approve(revenue.target, 100n * E18)
    const s = await (await revenue.connect(alice).stake(d20.target, 100n * E18)).wait()
    // fresh revenue mid-stream for every token so every stream folds on the next checkpoint
    for (const t of toks) await t.mint(revenue.target, 10n ** 25n)
    await revenue.syncAll()
    await time.increase(LOCK)
    const w = await (await revenue.connect(alice).withdraw(d20.target, 100n * E18)).wait()
    console.log(`      stake gas (20 tokens, cold user): ${s!.gasUsed}`)
    console.log(`      withdraw gas (20 tokens, streams ended): ${w!.gasUsed}`)
    expect(s!.gasUsed).to.be.lt(2_000_000n)
    expect(w!.gasUsed).to.be.lt(2_000_000n)
  })

  // ------------------------------------------------------- outside RevenueV2

  it('EXTERNAL: converter extractor can drain the D223 backing of the ERC-20 version (per repo source)', async () => {
    const { owner, alice, d223 } = await loadFixture(fixture)
    const conv = await (await ethers.getContractFactory('TokenStandardConverter')).deploy()
    // Wrapping ERC-223 D223 into its ERC-20 version goes through tokenReceived, which never updates
    // erc20Supply[D223]. extractStuckERC20 therefore treats the whole backing as "stuck".
    await d223.connect(alice)['transfer(address,uint256)'](conv.target, 1000n * E18)
    const w20 = await ethers.getContractAt('ERC20WrapperToken', await conv.getERC20WrapperFor(d223.target))
    expect(await w20.balanceOf(alice.address)).to.eq(1000n * E18)
    expect(await conv.erc20Supply(d223.target)).to.eq(0n)

    // RevenueV2 deployed against the real pair; alice stakes the ERC-20 version.
    const revenue = await (await ethers.getContractFactory('RevenueV2')).deploy(w20.target, d223.target, WEEK, LOCK, MIN_STAKE)
    await w20.connect(alice).approve(revenue.target, 1000n * E18)
    await revenue.connect(alice).stake(w20.target, 1000n * E18)

    const extractor = '0x01000B5fE61411C466b70631d7fF070187179Bbf'
    await network.provider.send('hardhat_impersonateAccount', [extractor])
    await owner.sendTransaction({ to: extractor, value: E18 })
    await conv.connect(await ethers.getSigner(extractor)).extractStuckERC20(d223.target)
    expect(await d223.balanceOf(conv.target)).to.eq(0n)

    // Alice still gets her 1000 ERC-20 D223 out of RevenueV2, but they no longer unwrap.
    await time.increase(LOCK)
    await revenue.connect(alice).withdraw(w20.target, 1000n * E18)
    await expect(conv.connect(alice).convertERC20(w20.target, 1000n * E18)).to.be.reverted
  })
})
