import { ethers } from 'hardhat'
import { MockTimeDex223Pool } from '../../typechain-types/'
import { TestERC20 } from '../../typechain-types/'
import { Dex223Factory, MockTimeDex223PoolLib, TokenStandardConverter } from '../../typechain-types/'
import { TestUniswapV3Callee } from '../../typechain-types/'
import { TestUniswapV3Router } from '../../typechain-types/'
import { MockTimeDex223PoolDeployer } from '../../typechain-types/'
import { AutoListingsRegistry, Dex223AutoListing } from '../../typechain-types/'

interface ListingFixture {
  registry: AutoListingsRegistry,
  listing: Dex223AutoListing,
  token0: TestERC20
  token1: TestERC20
  token2: TestERC20,
  factory: Dex223Factory,
  converter: TokenStandardConverter,
  createPool(
      fee: number,
      tickSpacing: number,
      firstToken?: TestERC20,
      secondToken?: TestERC20
  ): Promise<MockTimeDex223Pool>
}

export async function listingFixture(): Promise<ListingFixture> {
  const registryFactory = await ethers.getContractFactory('AutoListingsRegistry');
  const registry = (await registryFactory.deploy());

  const listingName = 'AutoTest listing';
  const listingUrl = 'none';

  const { token0, token1, token2, factory, converter, createPool } =  await poolFixture();

  const listingFactory = await ethers.getContractFactory('Dex223AutoListing');
  const listing = (await listingFactory.deploy(
      factory.target.toString(),
      registry.target.toString(),
      listingName,
      listingUrl
  ));

  return { registry, listing, token0, token1, token2, factory, converter, createPool };
}

interface FactoryFixture {
  factory: Dex223Factory,
  library: MockTimeDex223PoolLib,
  quoteLibrary: any,
  converter: TokenStandardConverter
}

export async function factoryFixture(): Promise<FactoryFixture> {
  const libraryFactory = await ethers.getContractFactory('MockTimeDex223PoolLib')
  const library = (await libraryFactory.deploy())

  const quoteLibraryFactory = await ethers.getContractFactory('Dex223QuoteLib')
  const quoteLibrary = (await quoteLibraryFactory.deploy())

  const converterFactory = await ethers.getContractFactory('TokenStandardConverter')
  const converter = (await converterFactory.deploy())

  const validatorFactory = await ethers.getContractFactory('Dex223TokenValidator')
  const validator = (await validatorFactory.deploy())

  const factoryFactory = await ethers.getContractFactory('Dex223Factory')
  const factory = (await factoryFactory.deploy(validator.target)) as Dex223Factory

  await factory.set(library.target, quoteLibrary.target, converter.target)

  return { factory, library, quoteLibrary, converter }
}

interface TokensFixture {
  token0: TestERC20
  token1: TestERC20
  token2: TestERC20
}

async function tokensFixture(): Promise<TokensFixture> {
  const tokenFactory = await ethers.getContractFactory('TestERC20')
  const tokenA = (await tokenFactory.deploy(ethers.MaxUint256)) as TestERC20
  const tokenB = (await tokenFactory.deploy(ethers.MaxUint256)) as TestERC20
  const tokenC = (await tokenFactory.deploy(ethers.MaxUint256)) as TestERC20

  const [token0, token1, token2] = [tokenA, tokenB, tokenC].sort((tokenA, tokenB) =>
    tokenA.target.toString().toLowerCase() < tokenB.target.toString().toLowerCase() ? -1 : 1
  )

  return { token0, token1, token2 }
}

type TokensAndFactoryFixture = FactoryFixture & TokensFixture

interface PoolFixture extends TokensAndFactoryFixture {
  swapTargetCallee: TestUniswapV3Callee
  swapTargetRouter: TestUniswapV3Router
  createPool(
    fee: number,
    tickSpacing: number,
    firstToken?: TestERC20,
    secondToken?: TestERC20
  ): Promise<MockTimeDex223Pool>
}

// Monday, October 5, 2020 9:00:00 AM GMT-05:00
export const TEST_POOL_START_TIME = 1601906400n

export async function poolFixture (): Promise<PoolFixture> {
  const { factory, library, converter } = await factoryFixture()
  const { token0, token1, token2 } = await tokensFixture()

  const MockTimeUniswapV3PoolDeployerFactory = await ethers.getContractFactory('MockTimeDex223PoolDeployer')
  const MockTimeUniswapV3PoolFactory = await ethers.getContractFactory('MockTimeDex223Pool')

  const calleeContractFactory = await ethers.getContractFactory('TestUniswapV3Callee')
  const routerContractFactory = await ethers.getContractFactory('TestUniswapV3Router')

  const swapTargetCallee = (await calleeContractFactory.deploy()) as TestUniswapV3Callee
  const swapTargetRouter = (await routerContractFactory.deploy()) as TestUniswapV3Router

  return {
    token0,
    token1,
    token2,
    factory,
    library,
    converter,
    swapTargetCallee,
    swapTargetRouter,
    createPool: async (fee, tickSpacing, firstToken = token0, secondToken = token1) => {
      const mockTimePoolDeployer = (await MockTimeUniswapV3PoolDeployerFactory.deploy()) as MockTimeDex223PoolDeployer
      const tx = await mockTimePoolDeployer.deploy(
        factory.target.toString(),
        firstToken.target.toString(),
        secondToken.target.toString(),
        fee,
        tickSpacing
      )

      const receipt = await tx.wait()

      // @ts-ignore
      const poolAddress = receipt?.logs?.[0].args?.[0] as string
      const pool = MockTimeUniswapV3PoolFactory.attach(poolAddress) as MockTimeDex223Pool

      // set 223 tokens
      let token2 = await converter.predictWrapperAddress(token0.target, true);
      let token3 = await converter.predictWrapperAddress(token1.target, true);

      await pool.testset(token2, token3, library.target,  converter.target);

      return pool
    },
  }
}
