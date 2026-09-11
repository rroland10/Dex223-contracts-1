import { ethers } from 'hardhat'
import {
  Dex223Factory,
  IWETH9,
  MockTimeSwapRouter, TokenStandardConverter
} from '../../typechain-types/'
import { factoryFixture } from './fixtures'
import WETH9 from '../contracts/WETH9.json'

interface WethFixture {
  weth9: IWETH9
}

interface RouterFixture {
  weth9: IWETH9
  factory: Dex223Factory
  router: MockTimeSwapRouter,
  converter: TokenStandardConverter
}

async function wethFixture(): Promise<WethFixture> {
  const [owner] = await ethers.getSigners();
  const wethFactory = new ethers.ContractFactory(WETH9.abi, WETH9.bytecode, owner)
  const weth9 = (await wethFactory.deploy()) as IWETH9

  return { weth9 }
}

export async function v3RouterFixture(): Promise<RouterFixture> {
  const { weth9 } = await wethFixture()
  const { factory, converter} = await factoryFixture()

  const routerFactory = await ethers.getContractFactory('MockTimeSwapRouter')
  const router = (await routerFactory.deploy(
      factory.target.toString(),
      weth9.target.toString(),
      converter.target.toString()
  )) as MockTimeSwapRouter

  return { factory, weth9, router , converter }
}
