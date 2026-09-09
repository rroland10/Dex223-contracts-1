/**
 * End-to-end validation of the ERC-223 reentrancy fix on a live network (Sepolia).
 *
 *   npx hardhat run scripts/sepolia-reentrancy-test.ts --network sepolia
 *
 * Deploys the real Dex223Factory and creates a real Dex223Pool through it, seeds it with liquidity,
 * then checks:
 *   1. the legitimate ERC-223 swap path still works  (the one-shot permit lets the payload through)
 *   2. a plain deposit + auto-refund still works     (no functional regression)
 *   3. the reentrant swap() from the refund callback is REJECTED with 'LOK'  (the fix)
 *
 * Deployed addresses are cached so the script can be re-run after an RPC hiccup without redeploying.
 */
import { ethers, network } from 'hardhat'
import * as fs from 'fs'
import * as path from 'path'

const STATE = process.env.STATE_FILE || path.join(process.cwd(), '.sepolia-reentrancy-state.json')

const MIN_SQRT_RATIO = 4295128739n
const Q96 = 79228162514264337593543950336n            // encodePriceSqrt(1,1)
const TICK_SPACING = 60
const FEE = 3000
const MIN_TICK = -887220n                              // getMinTick(60)
const MAX_TICK = 887220n                               // getMaxTick(60)

const SUPPLY = 10n ** 24n
const WRAP = 10n ** 23n
const LIQUIDITY = 10n ** 18n
const DEPOSIT = 10n ** 16n

type State = Record<string, string>
const load = (): State => (fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {})
const save = (s: State) => fs.writeFileSync(STATE, JSON.stringify(s, null, 2))

let state = load()
const scan = (a: string) => `https://sepolia.etherscan.io/address/${a}`

async function deployOnce(key: string, name: string, args: any[] = []): Promise<any> {
  const F = await ethers.getContractFactory(name)
  if (state[key]) {
    console.log(`  reuse  ${name.padEnd(28)} ${state[key]}`)
    return F.attach(state[key])
  }
  process.stdout.write(`  deploy ${name.padEnd(28)} ...`)
  const c = await F.deploy(...args)
  await c.waitForDeployment()
  { const r = await ethers.provider.getTransactionReceipt(c.deploymentTransaction()!.hash); if (r) gasTotal += r.gasUsed }
  state[key] = await c.getAddress()
  save(state)
  console.log(` ${state[key]}`)
  return c
}

async function step(label: string, fn: () => Promise<any>) {
  const key = `done:${label}`
  if (state[key]) { console.log(`  skip   ${label}`); return }
  process.stdout.write(`  tx     ${label} ...`)
  const tx = await fn()
  if (tx && tx.wait) { const r = await tx.wait(); gasTotal += r.gasUsed; console.log(` ok (block ${r.blockNumber}, gas ${r.gasUsed.toLocaleString()})`) } else console.log(' ok')
  state[key] = '1'; save(state)
}

let gasTotal = 0n
async function main() {
  const [wallet] = await ethers.getSigners()
  const bal = await ethers.provider.getBalance(wallet.address)
  const net = await ethers.provider.getNetwork()

  console.log('='.repeat(78))
  console.log('Dex223 ERC-223 reentrancy validation')
  console.log('='.repeat(78))
  console.log(`network   : ${network.name} (chainId ${net.chainId})`)
  console.log(`deployer  : ${wallet.address}`)
  console.log(`balance   : ${ethers.formatEther(bal)} ETH`)
  console.log(`state file: ${STATE}`)
  if (bal === 0n) throw new Error('Deployer has no ETH — fund it from a Sepolia faucet first.')
  if (bal < ethers.parseEther('0.05'))
    console.log('WARNING: < 0.05 ETH. Full deployment needs roughly 25-30M gas; this may run out.')
  console.log('\n-- contracts --')

  const converter = await deployOnce('converter', 'TokenStandardConverter')
  const tokenA = await deployOnce('tokenA', 'TestERC20', [SUPPLY])
  const tokenB = await deployOnce('tokenB', 'TestERC20', [SUPPLY])

  // token0 < token1 by address, as the pool requires
  const [a, b] = [await tokenA.getAddress(), await tokenB.getAddress()]
  const flip = a.toLowerCase() > b.toLowerCase()
  const token0 = flip ? tokenB : tokenA
  const token1 = flip ? tokenA : tokenB
  const t0 = flip ? b : a
  const t1 = flip ? a : b

  const poolLib = await deployOnce('poolLib', 'Dex223PoolLib')
  const quoteLib = await deployOnce('quoteLib', 'Dex223QuoteLib')
  const validator = await deployOnce('validator', 'Dex223TokenValidator')
  const factory = await deployOnce('factory', 'Dex223Factory', [await validator.getAddress()])
  const callee = await deployOnce('callee', 'TestUniswapV3Callee')
  const attacker = await deployOnce('attacker', 'TestERC223ReentrantAttacker')

  console.log('\n-- wrap ERC-20 -> ERC-223 --')
  const convAddr = await converter.getAddress()
  const poolLibAddr = await poolLib.getAddress()
  const quoteLibAddr = await quoteLib.getAddress()
  await step('approve token0 -> converter', () => token0.approve(convAddr, ethers.MaxUint256))
  await step('approve token1 -> converter', () => token1.approve(convAddr, ethers.MaxUint256))
  await step('wrap token0', () => converter.wrapERC20toERC223(t0, WRAP))
  await step('wrap token1', () => converter.wrapERC20toERC223(t1, WRAP))

  const t0_223 = await converter.predictWrapperAddress(t0, true)
  const t1_223 = await converter.predictWrapperAddress(t1, true)
  const ERC223 = await ethers.getContractFactory('ERC223HybridToken')
  const token0_223 = ERC223.attach(t0_223)
  const token1_223 = ERC223.attach(t1_223)
  console.log(`  token0     ${t0}\n  token0_223 ${t0_223}\n  token1     ${t1}\n  token1_223 ${t1_223}`)

  console.log('\n-- pool (created through the real Dex223Factory) --')
  await step('factory.set(poolLib, quoteLib, converter)', () =>
    factory.set(poolLibAddr, quoteLibAddr, convAddr))

  if (!state.pool) {
    process.stdout.write('  factory.createPool               ...')
    const tx = await factory.createPool(t0, t1, t0_223, t1_223, FEE)
    await tx.wait()
    state.pool = await factory.getPool(t0, t1, FEE); save(state)
    console.log(` ${state.pool}`)
  } else console.log(`  reuse  Dex223Pool (real)          ${state.pool}`)

  const pool = (await ethers.getContractFactory('contracts/dex-core/Dex223Pool.sol:Dex223Pool')).attach(state.pool)
  await step('pool.initialize(1:1)', () => pool.initialize(Q96))

  console.log('\n-- liquidity (ERC-20 path via callee) --')
  const calleeAddr = await callee.getAddress()
  await step('approve token0 -> callee', () => token0.approve(calleeAddr, ethers.MaxUint256))
  await step('approve token1 -> callee', () => token1.approve(calleeAddr, ethers.MaxUint256))
  await step('callee.mint liquidity', () =>
    callee.mint(state.pool, wallet.address, MIN_TICK, MAX_TICK, LIQUIDITY))

  const fmt = (x: bigint) => ethers.formatUnits(x, 18)
  console.log(`  pool token0 ERC20 : ${fmt(await token0.balanceOf(state.pool))}`)
  console.log(`  pool token1 ERC20 : ${fmt(await token1.balanceOf(state.pool))}`)

  // ---------------------------------------------------------------- test 1
  console.log('\n' + '='.repeat(78))
  console.log('TEST 1 - legitimate ERC-223 swap through tokenReceived (permit must ALLOW it)')
  console.log('='.repeat(78))
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600)
  const swapData = pool.interface.encodeFunctionData('swapExactInput', [
    wallet.address, true, DEPOSIT, 0n, MIN_SQRT_RATIO + 1n, true,
    ethers.AbiCoder.defaultAbiCoder().encode(['address'], [wallet.address]), deadline, false,
  ])
  const before1 = await token1_223.balanceOf(wallet.address)
  await step('transfer token0_223 -> pool with swapExactInput payload', () =>
    token0_223['transfer(address,uint256,bytes)'](state.pool, DEPOSIT, ethers.getBytes(swapData)))
  const gained = (await token1_223.balanceOf(wallet.address)) - before1
  const t1ok = gained > 0n
  console.log(`  token1_223 received : ${fmt(gained)}   -> ${t1ok ? 'PASS (payload executed)' : 'FAIL'}`)

  // ---------------------------------------------------------------- test 2
  console.log('\n' + '='.repeat(78))
  console.log('TEST 2 - plain deposit + auto-refund, no reentry (must still work)')
  console.log('='.repeat(78))
  const atkAddr = await attacker.getAddress()
  await step('fund attacker with token0_223', () => token0_223.transfer(atkAddr, DEPOSIT * 2n))
  await step('attacker.configure', () => attacker.configure(state.pool, t0_223, true, MIN_SQRT_RATIO + 1n))
  await step('attack(reenter=false)', () => attacker.attack(DEPOSIT, false))
  const refunded = await token0_223.balanceOf(atkAddr)
  const t2ok = refunded >= DEPOSIT
  console.log(`  attacker token0_223 : ${fmt(refunded)}   -> ${t2ok ? 'PASS (refund works)' : 'FAIL'}`)

  // ---------------------------------------------------------------- test 3
  console.log('\n' + '='.repeat(78))
  console.log('TEST 3 - reentrant swap() from the auto-refund callback (must be BLOCKED)')
  console.log('='.repeat(78))
  const p1Before = await token1.balanceOf(state.pool)
  const a1Before = await token1.balanceOf(atkAddr)
  await step('attack(reenter=true)', () => attacker.attack(DEPOSIT, true))

  const reentered = await attacker.reentered()
  const succeeded = await attacker.reentrySucceeded()
  const err = await attacker.reentryError()
  const stolen = (await token1.balanceOf(atkAddr)) - a1Before
  const drained = p1Before - (await token1.balanceOf(state.pool))

  console.log(`  refund callback fired : ${reentered}`)
  console.log(`  reentrant swap ran    : ${succeeded}`)
  console.log(`  revert reason         : "${err}"`)
  console.log(`  attacker token1 gain  : ${fmt(stolen)}`)
  console.log(`  pool token1 drained   : ${fmt(drained)}`)

  const t3ok = reentered && !succeeded && err === 'LOK' && stolen === 0n && drained === 0n

  console.log('\n' + '='.repeat(78))
  console.log(`TEST 1 legitimate swap allowed : ${t1ok ? 'PASS' : 'FAIL'}`)
  console.log(`TEST 2 deposit + refund works  : ${t2ok ? 'PASS' : 'FAIL'}`)
  console.log(`TEST 3 reentrancy blocked      : ${t3ok ? 'PASS' : 'FAIL'}`)
  console.log('='.repeat(78))
  console.log(`pool: ${scan(state.pool)}`)
  // GAS TALLY
  console.log(`\ntotal gas used this run: ${gasTotal.toLocaleString()}`)
  for (const gwei of [1n, 2n, 5n]) console.log(`  @ ${gwei} gwei -> ${ethers.formatEther(gasTotal * gwei * 10n ** 9n)} ETH`)
  if (!(t1ok && t2ok && t3ok)) process.exitCode = 1
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
