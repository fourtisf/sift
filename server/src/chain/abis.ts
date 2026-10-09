import { parseAbi } from 'viem';

export const factoryAbi = parseAbi([
  'event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)',
  'event PoolGraduated(address indexed token, uint256 a, uint256 b, uint256 c)',
]);

export const curveAbi = parseAbi([
  'event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)',
  'event CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax)',
  'function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256)',
  'function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256)',
  'function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)',
  'function realQuoteReserve() view returns (uint256)',
  'function sellableTokens() view returns (uint256)',
  'function graduationThreshold() view returns (uint256)',
  'function feeBps() view returns (uint256)',
  'function creatorTaxBps() view returns (uint256)',
  'function currentSnipeTaxBps(address recipient) view returns (uint256)',
  'function readyToGraduate() view returns (bool)',
  'function graduated() view returns (bool)',
]);

export const erc20Abi = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function balanceOf(address) view returns (uint256)',
]);

/** Pons launch tokens expose their metadata. Layout taken from the Pons docs; verify on a live token. */
export const ponsTokenInfoAbi = parseAbi([
  'function getTokenInfo() view returns (address tokenDeployer, string tokenLogo, string tokenDescription, (string twitter, string telegram, string discord, string website, string farcaster) tokenSocials)',
]);

export const poolManagerAbi = parseAbi([
  'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
]);

export const stateViewAbi = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
]);

export const v4QuoterAbi = [
  {
    type: 'function',
    name: 'quoteExactInputSingle',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          {
            name: 'poolKey',
            type: 'tuple',
            components: [
              { name: 'currency0', type: 'address' },
              { name: 'currency1', type: 'address' },
              { name: 'fee', type: 'uint24' },
              { name: 'tickSpacing', type: 'int24' },
              { name: 'hooks', type: 'address' },
            ],
          },
          { name: 'zeroForOne', type: 'bool' },
          { name: 'exactAmount', type: 'uint128' },
          { name: 'hookData', type: 'bytes' },
        ],
      },
    ],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
  },
] as const;

export const vaultAbi = parseAbi([
  'function buyOnCurve(address curve, uint256 ethIn, uint256 minTokensOut, address token) returns (uint256)',
  'function sellOnCurve(address curve, address token, uint256 tokensIn, uint256 minEthOut) returns (uint256)',
  'function buyOnPool(address token, uint256 ethIn, uint256 minTokensOut, uint256 deadline) returns (uint256)',
  'function sellOnPool(address token, uint256 tokensIn, uint256 minEthOut, uint256 deadline) returns (uint256)',
  'function pause()',
  'function agent() view returns (address)',
  'function owner() view returns (address)',
  'function paused() view returns (bool)',
  'function maxPerTrade() view returns (uint256)',
  'function dailyCap() view returns (uint256)',
  'function remainingToday() view returns (uint256)',
]);

export const vaultFactoryAbi = parseAbi([
  'function vaultOf(address owner) view returns (address)',
  'function createVault(address agent, uint256 maxPerTrade, uint256 dailyCap) returns (address)',
]);
