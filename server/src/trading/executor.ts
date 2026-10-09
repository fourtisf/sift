import { createPublicClient, createWalletClient, http, type PublicClient, type WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { erc20Abi, vaultAbi } from '../chain/abis.js';
import { robinhood } from '../chain/robinhood.js';
import { config } from '../config.js';
import type { Market } from '../market/market.js';
import type { MarketSource } from '../sources/types.js';
import type { Store, UserRow } from '../store/db.js';
import type { Address } from '../types.js';
import { curveBuyOut, curveSellOut, minOut, toEth } from './quote.js';

export interface Fill {
  ethIn: number; // ETH spent (buy) or received (sell)
  tokens: bigint;
  venue: 'curve' | 'pool';
  tx: `0x${string}` | null;
  gasEth: number;
}

/** Prices a trade on whichever venue the token currently lives on. */
export class Venue {
  constructor(private src: MarketSource, private market: Market) {}

  async quoteBuy(token: Address, ethIn: bigint): Promise<{ out: bigint; venue: 'curve' | 'pool' }> {
    const st = this.market.get(token);
    if (!st) throw new Error('unknown token');
    if (!st.graduated) {
      const c = await this.src.curveState(st.launch.curve);
      if (!c.graduated) return { out: curveBuyOut(c, ethIn), venue: 'curve' };
      st.graduated = true;
    }
    return { out: await this.src.quotePoolBuy(token, ethIn), venue: 'pool' };
  }

  async quoteSell(token: Address, tokensIn: bigint): Promise<{ out: bigint; venue: 'curve' | 'pool' }> {
    const st = this.market.get(token);
    if (!st) throw new Error('unknown token');
    if (!st.graduated) {
      const c = await this.src.curveState(st.launch.curve);
      if (!c.graduated) return { out: curveSellOut(c, tokensIn), venue: 'curve' };
      st.graduated = true;
    }
    return { out: await this.src.quotePoolSell(token, tokensIn), venue: 'pool' };
  }
}

export interface Executor {
  balance(u: UserRow): Promise<number>;
  buy(u: UserRow, token: Address, ethIn: bigint, slipPct: number): Promise<Fill>;
  sell(u: UserRow, token: Address, tokensIn: bigint, slipPct: number): Promise<Fill>;
}

const PAPER_GAS_ETH = 0.00002;

/** Fills at the live quote, books the result in the user's paper balance. No transactions are sent. */
export class PaperExecutor implements Executor {
  constructor(private venue: Venue, private store: Store) {}

  async balance(u: UserRow) {
    return this.store.user(u.address)?.paper_eth ?? 0;
  }

  async buy(u: UserRow, token: Address, ethIn: bigint): Promise<Fill> {
    const eth = toEth(ethIn);
    if ((await this.balance(u)) < eth + PAPER_GAS_ETH) throw new Error('Not enough paper ETH');
    const q = await this.venue.quoteBuy(token, ethIn);
    if (q.out <= 0n) throw new Error('No liquidity');
    this.store.addPaper(u.address, -(eth + PAPER_GAS_ETH));
    return { ethIn: eth, tokens: q.out, venue: q.venue, tx: null, gasEth: PAPER_GAS_ETH };
  }

  async sell(u: UserRow, token: Address, tokensIn: bigint): Promise<Fill> {
    const q = await this.venue.quoteSell(token, tokensIn);
    const eth = toEth(q.out);
    this.store.addPaper(u.address, eth - PAPER_GAS_ETH);
    return { ethIn: eth, tokens: tokensIn, venue: q.venue, tx: null, gasEth: PAPER_GAS_ETH };
  }
}

/** Sends real transactions through the user's SiftVault. The agent key can only trade inside the vault. */
export class LiveExecutor implements Executor {
  private pub: PublicClient;
  private wallet: WalletClient;
  private account;

  constructor(private venue: Venue, private market: Market) {
    if (!config.agentPrivateKey) throw new Error('AGENT_PRIVATE_KEY is not set');
    this.account = privateKeyToAccount(config.agentPrivateKey);
    this.pub = createPublicClient({ chain: robinhood, transport: http(config.rpcHttp) }) as PublicClient;
    this.wallet = createWalletClient({ chain: robinhood, transport: http(config.rpcHttp), account: this.account });
  }

  get agentAddress() {
    return this.account.address;
  }

  private vault(u: UserRow): Address {
    if (!u.vault) throw new Error('No vault yet. Create one from the Wallet screen.');
    return u.vault as Address;
  }

  async balance(u: UserRow) {
    if (!u.vault) return 0;
    return toEth(await this.pub.getBalance({ address: u.vault as Address }));
  }

  private async tokenBal(token: Address, holder: Address) {
    return (await this.pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [holder] })) as bigint;
  }

  private async send(fn: Parameters<typeof this.pub.simulateContract>[0]) {
    const { request } = await this.pub.simulateContract({ ...fn, account: this.account } as never);
    const hash = await this.wallet.writeContract(request as never);
    const rc = await this.pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
    if (rc.status !== 'success') throw new Error(`Transaction reverted: ${hash}`);
    return { hash, gasEth: toEth(rc.gasUsed * rc.effectiveGasPrice) };
  }

  async buy(u: UserRow, token: Address, ethIn: bigint, slipPct: number): Promise<Fill> {
    if (!config.liveTradingEnabled) throw new Error('Live trading is switched off on this server');
    const vault = this.vault(u);
    const st = this.market.get(token);
    if (!st) throw new Error('unknown token');
    const q = await this.venue.quoteBuy(token, ethIn);
    const min = minOut(q.out, slipPct);
    const before = await this.tokenBal(token, vault);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 120);
    const tx =
      q.venue === 'curve'
        ? await this.send({ address: vault, abi: vaultAbi, functionName: 'buyOnCurve', args: [st.launch.curve, ethIn, min, token] })
        : await this.send({ address: vault, abi: vaultAbi, functionName: 'buyOnPool', args: [token, ethIn, min, deadline] });
    const got = (await this.tokenBal(token, vault)) - before;
    return { ethIn: toEth(ethIn), tokens: got, venue: q.venue, tx: tx.hash, gasEth: tx.gasEth };
  }

  async sell(u: UserRow, token: Address, tokensIn: bigint, slipPct: number): Promise<Fill> {
    const vault = this.vault(u);
    const st = this.market.get(token);
    if (!st) throw new Error('unknown token');
    const held = await this.tokenBal(token, vault);
    const amount = tokensIn > held ? held : tokensIn;
    if (amount === 0n) return { ethIn: 0, tokens: 0n, venue: 'curve', tx: null, gasEth: 0 };
    const q = await this.venue.quoteSell(token, amount);
    const min = minOut(q.out, slipPct);
    const before = await this.pub.getBalance({ address: vault });
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 120);
    const tx =
      q.venue === 'curve'
        ? await this.send({ address: vault, abi: vaultAbi, functionName: 'sellOnCurve', args: [st.launch.curve, token, amount, min] })
        : await this.send({ address: vault, abi: vaultAbi, functionName: 'sellOnPool', args: [token, amount, min, deadline] });
    const after = await this.pub.getBalance({ address: vault });
    return { ethIn: toEth(after - before), tokens: amount, venue: q.venue, tx: tx.hash, gasEth: tx.gasEth };
  }
}
