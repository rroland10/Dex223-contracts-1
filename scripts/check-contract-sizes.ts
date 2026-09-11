/**
 * Fails if any deployable contract exceeds the EIP-170 24,576-byte runtime limit.
 *
 *   npx hardhat run scripts/check-contract-sizes.ts
 *
 * The hardhat network sets `allowUnlimitedContractSize: true`, so oversized contracts pass every test
 * and only fail when you try to deploy them to a real chain. Run this before deploying.
 */
import { artifacts } from 'hardhat'

const LIMIT = 24576
const WARN_AT = 0.95

async function main() {
  const names = await artifacts.getAllFullyQualifiedNames()
  const rows: { name: string; size: number }[] = []

  for (const n of names) {
    const a = await artifacts.readArtifact(n)
    const size = (a.deployedBytecode.length - 2) / 2
    if (size > 0) rows.push({ name: n, size })
  }

  rows.sort((a, b) => b.size - a.size)
  const over = rows.filter((r) => r.size > LIMIT)
  const near = rows.filter((r) => r.size <= LIMIT && r.size >= LIMIT * WARN_AT)

  console.log(`Largest deployable contracts (limit ${LIMIT.toLocaleString()} bytes):\n`)
  for (const r of rows.slice(0, 12)) {
    const pct = ((r.size / LIMIT) * 100).toFixed(1)
    const flag = r.size > LIMIT ? 'OVER' : r.size >= LIMIT * WARN_AT ? 'near' : 'ok'
    console.log(`  ${flag.padEnd(5)} ${r.size.toString().padStart(7)}  ${pct.padStart(6)}%  ${r.name}`)
  }

  if (near.length) {
    console.log(`\n${near.length} contract(s) within ${((1 - WARN_AT) * 100).toFixed(0)}% of the limit.`)
  }
  if (over.length) {
    console.error(`\nFAIL: ${over.length} contract(s) exceed the limit and cannot be deployed:`)
    for (const r of over) console.error(`  ${r.name}  ${r.size} (+${r.size - LIMIT})`)
    process.exitCode = 1
  } else {
    console.log('\nOK: every contract fits within the EIP-170 limit.')
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
