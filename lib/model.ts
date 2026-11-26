// Launch Radar model: one sealed DefiLlama snapshot in, one ranked board out.
//
// THE MODEL (also stated in the dashboard and the README, in the same words)
// ------------------------------------------------------------------------
// The board ranks every protocol in the snapshot that records no token and is
// not a wrapped, staked or bridged product of one that trades. A protocol's
// implied value is what a token would be worth if the protocol's record
// stayed as it is. It is built only from the snapshot's own figures:
//
//   implied = TVL x category multiple x growth factor x track-record factor
//
// 1. Category multiple. Protocols whose token already trades are the
//    comparables: for each of them the snapshot gives a market cap and a TVL,
//    so their market-cap-to-TVL ratio is a fact of the snapshot, not an
//    opinion. Each ratio is winsorised to [0.01, 10] so one broken record
//    cannot move a median. A category's multiple is the median of its
//    comparables' ratios, shrunk toward the global median with a prior
//    weight of 4 comparable protocols:
//
//        multiple(cat) = (n x median(cat) + 4 x median(all)) / (n + 4)
//
//    A category with no traded comparable takes the global median. The
//    result is clamped to [0.02, 3]: outside that band the snapshot's own
//    record gives no support. Because the multiple comes from the traded
//    set of the same category, a lending market is priced like lending
//    markets and an exchange like exchanges, never by one flat rate.
//
// 2. Growth factor. Seven-day TVL change is a momentum signal, damped
//    because one week is noisy: 1 + 0.30 x clamp(change_7d, -50, +100)/100,
//    a factor between 0.85 and 1.30. An unreported change counts as 0.
//
// 3. Track-record factor. A protocol that has run longer at size with no
//    token has the deeper record a launch would be priced on:
//    0.80 + 0.35 x (1 - exp(-age_days / 540)), rising from 0.80 toward 1.15
//    and saturating near four years. Age is the days from DefiLlama's
//    listed_at to the snapshot's as_of; an unreported age counts as 365.
//
// No protocol name is ever special-cased: the same functions score every
// row, and the comparables are recomputed from the snapshot on every run,
// so the same program re-run on a future snapshot re-derives its own board.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's version label, named in the dashboard, the board and the README. */
export const MODEL_VERSION = 'launch-radar-2';

/** The model's constants, stated in the dashboard's Model view. */
export const MODEL = {
  /** Each comparable's market-cap-to-TVL ratio is winsorised into this band before any median. */
  ratio_floor: 0.01,
  ratio_cap: 10,
  /** Prior weight, in phantom comparable protocols, pulling a category median toward the global one. */
  shrink_prior: 4,
  /** A category multiple is only ever stated inside this band. */
  multiple_floor: 0.02,
  multiple_cap: 3,
  /** Growth: the factor is 1 + growth_weight x clamped change / 100. */
  growth_weight: 0.3,
  growth_floor_pct: -50,
  growth_cap_pct: 100,
  /** Track record: floor + range x (1 - exp(-age / tau_days)). */
  track_floor: 0.8,
  track_range: 0.35,
  track_tau_days: 540,
  unknown_age_days: 365,
} as const;

/** One category's comparable set: how many traded protocols, their median ratio, the multiple used. */
export interface CategoryMultiple {
  category: string;
  comps: number;
  median_ratio: number | null;
  multiple: number;
}

/** One row of board.json: the ranked board's row, with the model's working shown. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  on_watchlist: boolean;
  implied_value_usd: number;
  model: {
    category_multiple: number;
    category_comps: number;
    growth_factor: number;
    track_factor: number;
  };
  farm_steps: string[];
}

/** A traded protocol, shown in the dashboard's comparables view at its market value, never ranked. */
export interface LiveRow {
  slug: string;
  name: string;
  symbol: string | null;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  ratio: number;
  change_7d: number | null;
}

/** The dashboard's compact row: the board row plus its farm plan. */
export interface RadarRow extends BoardRow {}

/** Everything the dashboard renders, from the snapshot. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  protocol_count: number;
  watchlist_size: number;
  board_size: number;
  live_size: number;
  total_implied_usd: number;
  global_median_ratio: number;
  categories: CategoryMultiple[];
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** A whole day count from `listedAt` to `asOf`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Whether a protocol records a token: a CoinGecko id or a symbol in its record. */
export function recordsToken(p: SnapshotProtocol): boolean {
  return p.gecko_id !== null || p.symbol !== null;
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
/** A whole word that marks a wrapped or staked product of another asset. */
const PRODUCT_WORD = /\b(wrapped|staked|staking)\b/i;
/** Categories that are products of another protocol's asset, not protocols awaiting a launch. */
const PRODUCT_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
/** Exchange names a product of an exchange begins with. */
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/**
 * Whether a protocol is a wrapped, staked or bridged product of one whose token already trades:
 * the watchlist's own exclusions, applied to the whole board, not only above the floor.
 */
export function isProduct(p: SnapshotProtocol): boolean {
  if (p.category !== null && PRODUCT_CATEGORIES.has(p.category)) return true;
  if (VERSIONED.test(p.name)) return true;
  if (PRODUCT_WORD.test(p.name)) return true;
  return EXCHANGE_PREFIXES.some((x) => p.name.startsWith(x));
}

/** Whether the board ranks a protocol: it records no token and is no product of one that trades. */
export function isRankable(p: SnapshotProtocol): boolean {
  return !recordsToken(p) && p.mcap_usd === null && !isProduct(p);
}

/** The median of a non-empty list of numbers. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The comparables: every protocol whose token trades with both a market cap and a TVL in the
 * snapshot, grouped by category, each ratio winsorised. Returns the global median ratio and
 * each category's shrunk multiple, in category order.
 */
export function categoryMultiples(snapshot: Snapshot): { globalMedian: number; categories: CategoryMultiple[] } {
  const byCategory = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const ratio = clamp(p.mcap_usd / p.tvl_usd, MODEL.ratio_floor, MODEL.ratio_cap);
    all.push(ratio);
    const cat = p.category ?? 'Uncategorised';
    const list = byCategory.get(cat) ?? [];
    list.push(ratio);
    byCategory.set(cat, list);
  }
  const globalMedian = all.length > 0 ? median(all) : 0.2;
  const categories: CategoryMultiple[] = [];
  const cats = new Set<string>([...byCategory.keys(), ...snapshot.protocols.map((p) => p.category ?? 'Uncategorised')]);
  for (const cat of [...cats].sort()) {
    const list = byCategory.get(cat) ?? [];
    const med = list.length > 0 ? median(list) : null;
    const shrunk = med === null ? globalMedian : (list.length * med + MODEL.shrink_prior * globalMedian) / (list.length + MODEL.shrink_prior);
    categories.push({ category: cat, comps: list.length, median_ratio: med === null ? null : round4(med), multiple: round4(clamp(shrunk, MODEL.multiple_floor, MODEL.multiple_cap)) });
  }
  return { globalMedian, categories };
}

/** The growth factor one protocol gets: its seven-day TVL change, damped. */
export function growthFactor(change7d: number | null): number {
  const pct = clamp(change7d ?? 0, MODEL.growth_floor_pct, MODEL.growth_cap_pct);
  return 1 + (MODEL.growth_weight * pct) / 100;
}

/** The track-record factor one protocol gets: its age with no token, saturating near four years. */
export function trackFactor(age: number | null): number {
  const days = age ?? MODEL.unknown_age_days;
  return MODEL.track_floor + MODEL.track_range * (1 - Math.exp(-days / MODEL.track_tau_days));
}

/** The implied value of one pre-token protocol, with the model's working. */
export function impliedValue(
  p: SnapshotProtocol,
  asOf: string,
  multiples: Map<string, CategoryMultiple>,
): { implied: number; multiple: number; comps: number; gf: number; tf: number; age: number | null } {
  const age = ageDays(asOf, p.listed_at);
  const entry = multiples.get(p.category ?? 'Uncategorised');
  const multiple = entry?.multiple ?? 0.2;
  const gf = growthFactor(p.change_7d);
  const tf = trackFactor(age);
  const implied = Math.max(1, Math.round(p.tvl_usd * multiple * gf * tf));
  return { implied, multiple, comps: entry?.comps ?? 0, gf, tf, age };
}

// ------------------------------------------------------------------ farm plans
//
// A farm plan is assembled from the protocol's own record: its category sets
// the position and the weekly activity, its first chain sets where the work
// happens and what gas costs, its TVL sets the capital a meaningful position
// needs, and its age sets how long the position must be held to count in
// more than one eligibility snapshot. Every step states its cost and time.

/** The capital a meaningful farm position needs, from the protocol's TVL. */
function capitalFor(tvl: number): number {
  if (tvl >= 1_000_000_000) return 500;
  if (tvl >= 250_000_000) return 250;
  if (tvl >= 50_000_000) return 150;
  if (tvl >= 10_000_000) return 100;
  return 50;
}

/** One round trip's gas on the protocol's first chain: mainnet is dear, rollups and Solana are not. */
function gasFor(chain: string): { label: string; roundTrip: number; weekly: number } {
  if (chain === 'Ethereum') return { label: 'Ethereum mainnet', roundTrip: 14, weekly: 6 };
  if (chain === 'Solana') return { label: 'Solana', roundTrip: 1, weekly: 1 };
  if (chain === 'Bitcoin') return { label: 'Bitcoin', roundTrip: 4, weekly: 2 };
  return { label: chain, roundTrip: 2, weekly: 1 };
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** A category's position, weekly activity and standing risk, in the words a farmer can follow. */
interface Playbook {
  position: (name: string, chain: string, capital: number) => string;
  activity: string;
  risk: string;
}

const PLAYBOOKS: Record<string, Playbook> = {
  Dexs: {
    position: (n, c, k) => `Provide $${k} split evenly across both sides of ${n}'s deepest pool on ${c}, and make two small swaps through the same pool so the wallet both trades and provides.`,
    activity: 'add or rebalance the position and make at least two swaps a week, so the wallet shows up as a recurring trader and liquidity provider, not a one-day visitor',
    risk: 'impermanent loss if the pair moves apart, so favour a stable or major pair over a volatile one',
  },
  Lending: {
    position: (n, c, k) => `Supply $${k} of USDC or ETH as collateral in ${n} on ${c}, then borrow about a third of it back and repay within the week, so the wallet has both supplied and borrowed.`,
    activity: 'top the collateral up or adjust the borrow once a week and never let the health factor fall below 2, so the position survives a bad day without a liquidation',
    risk: 'liquidation if collateral value falls fast, plus variable rates that can turn a borrow expensive',
  },
  CDP: {
    position: (n, c, k) => `Open a vault in ${n} on ${c} with $${k} of ETH collateral at no more than half the liquidation ratio, and mint the protocol's stablecoin against it.`,
    activity: 'check the vault weekly, add collateral whenever the ratio drifts toward the liquidation line, and hold the minted stablecoin in the same wallet',
    risk: 'liquidation at the vault ratio and a stability fee that accrues on the minted amount',
  },
  'CDP Manager': {
    position: (n, c, k) => `Open a managed vault position of $${k} through ${n} on ${c}, collateralised well above its liquidation ratio, and mint against it.`,
    activity: 'review the managed position weekly and add collateral on any drift toward liquidation, keeping the minted balance in the farming wallet',
    risk: 'liquidation, stability fees, and the manager layer taking its own cut of the yield',
  },
  Yield: {
    position: (n, c, k) => `Deposit $${k} into ${n}'s flagship yield vault on ${c} and keep the vault shares in the wallet that deposited.`,
    activity: 'make one further small deposit each week and claim rewards only into the same wallet, building an unbroken deposit history',
    risk: 'the vault strategy can lose money even when the chain asset does not, so read the strategy before sizing up',
  },
  'Yield Aggregator': {
    position: (n, c, k) => `Deposit $${k} into the ${n} vault on ${c} whose strategy you can read end to end, and keep the shares unmoved.`,
    activity: 'add a small deposit weekly and let the aggregator rebalance; do not chase its highest-APY vault, which is usually its riskiest',
    risk: 'stacked smart-contract risk: the aggregator and every protocol its strategy touches',
  },
  'Risk Curators': {
    position: (n, c, k) => `Deposit $${k} into a ${n}-curated vault on ${c} (the curator's name is on the vault, the assets sit in the underlying lending market) and keep the shares.`,
    activity: 'check the curator allocation page monthly and add a small deposit weekly, so the wallet is a standing depositor when any snapshot is taken',
    risk: 'curator strategy risk: a bad allocation can lose money the base lending market never offered',
  },
  'Onchain Capital Allocator': {
    position: (n, c, k) => `Deposit $${k} into an allocator vault run through ${n} on ${c} and hold the shares in the depositing wallet.`,
    activity: 'add a small deposit each week and read the allocator reallocation notes monthly, moving only if an allocation turns reckless',
    risk: 'allocator discretion: capital follows the allocator strategy, including into markets you did not choose',
  },
  RWA: {
    position: (n, c, k) => `Complete ${n}'s onboarding or KYC if it asks, then mint or buy $${k} of its tokenised real-world asset on ${c} and hold it.`,
    activity: 'hold the asset and claim its yield on schedule; add a small amount monthly rather than trading in and out',
    risk: 'issuer and redemption risk: the asset is a claim on an off-chain obligor, and exits can be slower than a chain trade',
  },
  Derivatives: {
    position: (n, c, k) => `Deposit $${k} of USDC margin on ${n} (${c}) and open one small hedged perpetual position, a long and a short of near-equal size on two majors.`,
    activity: 'trade a few small hedged positions each week to build genuine volume and fee history without directional bets',
    risk: 'funding payments on both legs and liquidation if a hedge leg is closed carelessly; keep leverage at 1-2x',
  },
  'Interest Rate Derivatives': {
    position: (n, c, k) => `Deposit $${k} of margin on ${n} (${c}) and open one small fixed-versus-variable rate position you can explain.`,
    activity: 'roll or adjust one position a week so the wallet carries continuous, genuine rate-market activity',
    risk: 'rate moves against the position and thin books that make exits cost more than the screen shows',
  },
  'Basis Trading': {
    position: (n, c, k) => `Deposit $${k} of USDC into ${n}'s basis vault on ${c}, which holds the hedged spot-and-perpetual pair for you.`,
    activity: 'add a small deposit weekly and read the vault funding report; withdraw only if funding stays negative for a full week',
    risk: 'funding can flip negative for weeks, and the vault hedge is only as good as its execution',
  },
  'Prediction Market': {
    position: (n, c, k) => `Fund the wallet with $${k} on ${c} and take small positions on ${n}'s most liquid markets, a few dollars each.`,
    activity: 'trade two or three liquid markets a week and let positions settle; steady participation counts more than one large bet',
    risk: 'every position can settle at zero, so size each one as money already spent',
  },
  Chain: {
    position: (n, c, k) => `Bridge $${k} to ${n}'s chain and hold it there in the chain's native asset and a stablecoin, using the chain's own apps for the moves.`,
    activity: 'make several native transactions a week (transfers, swaps, one contract call) so the wallet reads as a resident, not a tourist',
    risk: 'bridge risk on the way in and out, and a young chain whose apps are thin',
  },
  'Staking Pool': {
    position: (n, c, k) => `Stake $${k} of the chain's staking asset through ${n} on ${c} and keep the staking position under the farming wallet.`,
    activity: 'compound or top up the stake monthly and vote with it where the pool passes votes through',
    risk: 'unbonding periods lock the asset, and slashing, though rare, is the staker loss',
  },
  Restaking: {
    position: (n, c, k) => `Deposit $${k} of a liquid staking token into ${n} on ${c} and keep the restaked position.`,
    activity: 'hold through at least two operator or AVS changes and add a small amount monthly, showing a standing restaker',
    risk: 'slashing across every service the stake secures, stacked on the underlying staking token own risk',
  },
  'Liquidity Manager': {
    position: (n, c, k) => `Deposit $${k} into a ${n}-managed concentrated-liquidity vault on ${c} and keep the vault shares.`,
    activity: 'check the position weekly; the manager rebalances the range, so your job is staying deposited, not trading',
    risk: 'impermanent loss inside the managed range and fees that only pay off in busy markets',
  },
  'Leveraged Farming': {
    position: (n, c, k) => `Open a $${k} leveraged yield position on ${n} (${c}) at no more than 2x, in a stable or major pair.`,
    activity: 'check the position twice a week and deleverage on any sharp move; boring survival is the whole strategy',
    risk: 'liquidation is fast at leverage, and borrow rates can eat the farmed yield',
  },
  Insurance: {
    position: (n, c, k) => `Put $${k} into ${n}'s underwriting pool on ${c}, or buy cover on a position you actually hold if the pool side is closed.`,
    activity: 'keep the cover or underwriting in force and renew on schedule, building a continuous policy history',
    risk: 'underwriting pays until it does not: one large claim event can take a year yield',
  },
  Launchpad: {
    position: (n, c, k) => `Hold $${k} of the assets ${n} counts toward allocation on ${c} and register the wallet before its next sale opens.`,
    activity: 'take part in each sale round at a small size and hold what you receive for at least a month',
    risk: 'sale tokens are illiquid and often fall after listing; never chase an allocation with size',
  },
  Indexes: {
    position: (n, c, k) => `Mint $${k} of ${n}'s index product on ${c} and hold the basket token in the farming wallet.`,
    activity: 'add a small amount monthly and hold through rebalances, so the wallet is a standing holder',
    risk: 'the basket is only as strong as its weakest constituent, and mint/redemption spreads are real costs',
  },
  Payments: {
    position: (n, c, k) => `Open a ${n} account, fund it with $${k} on ${c}, and route real payments you would make anyway through it.`,
    activity: 'make a few genuine payments a week; real usage is the whole farm here, and faked volume is easy to spot',
    risk: 'account freezes and KYC reviews are the standing risk of any payments product',
  },
  'Crypto Card Issuer': {
    position: (n, c, k) => `Order the ${n} card if your country is served, load $${k}, and spend through it on ordinary purchases.`,
    activity: 'use the card weekly for real spending and keep a balance loaded, which is the activity a launch would reward',
    risk: 'card programmes change terms and countries served with little notice',
  },
  Farm: {
    position: (n, c, k) => `Deposit $${k} into ${n}'s main farm pool on ${c} and stake the position in its farm contract.`,
    activity: 'harvest and restake weekly, keeping the position staked across snapshots rather than farming one day',
    risk: 'the farmed reward (often points or a partner token) can be worth little, and pool assets carry their own risk',
  },
  Synthetics: {
    position: (n, c, k) => `Deposit $${k} of collateral on ${n} (${c}) and mint a small amount of its synthetic asset against it.`,
    activity: 'hold the synthetic and the collateral together and rebalance weekly to keep the ratio safe',
    risk: 'collateral ratios are enforced by liquidation, and synthetic prices can depeg in stress',
  },
  'Dual-Token Stablecoin': {
    position: (n, c, k) => `Mint or buy $${k} of ${n}'s stablecoin on ${c} and hold it, keeping a small amount of the companion asset too if it trades.`,
    activity: 'hold the stablecoin in the wallet and use it in one partner integration a week',
    risk: 'algorithmic and dual-token designs have broken before; size as an experiment, not a savings account',
  },
  'Algo-Stables': {
    position: (n, c, k) => `Mint or buy $${k} of ${n}'s stablecoin on ${c} and hold it in the farming wallet.`,
    activity: 'hold steadily and add small amounts monthly; churn is not the farm here',
    risk: 'algorithmic pegs are the most fragile design in this snapshot; keep the position small',
  },
  'Stablecoin Wrapper': {
    position: (n, c, k) => `Wrap $${k} of the underlying stablecoin through ${n} on ${c} and hold the wrapped balance.`,
    activity: 'keep the wrapped balance and use it in one listed integration a week',
    risk: 'wrapper contracts add a layer over the underlying asset; the peg underneath is the real exposure',
  },
  'Uncollateralized Lending': {
    position: (n, c, k) => `Lend $${k} into a ${n} pool on ${c} whose borrowers and terms are disclosed, starting with its shortest pool.`,
    activity: 'roll the loan at each maturity and diversify across pools rather than concentrating in the highest rate',
    risk: 'unsecured means exactly that: a borrower default is the lender loss',
  },
  'Collateral Markets': {
    position: (n, c, k) => `Supply $${k} of collateral assets into ${n} on ${c} in its main market and keep the supply position open.`,
    activity: 'adjust the supplied mix monthly as markets are added, keeping a continuous supply history',
    risk: 'exotic collateral can gap down; stick to the major-asset markets',
  },
  'OTC Marketplace': {
    position: (n, c, k) => `List or fill one small genuine order of about $${k} on ${n} (${c}) for an asset you actually want to trade.`,
    activity: 'complete one small trade a month; OTC desks reward completed counterparties, not listed intentions',
    risk: 'counterparty and settlement terms differ per trade; read each one before signing',
  },
  Governance: {
    position: (n, c, k) => `Hold $${k} of the assets ${n} counts on ${c} and delegate or register the wallet in its governance system.`,
    activity: 'vote on every proposal while you farm; a voting record is the cheapest credible activity there is',
    risk: 'governance tokens and points have no guaranteed value, and votes are public',
  },
};

/** The fallback playbook, for a category with no entry of its own. */
const FALLBACK: Playbook = {
  position: (n, c, k) => `Deposit $${k} into ${n}'s main product on ${c} and keep the position open in the wallet that made it.`,
  activity: 'repeat the product\'s core action once a week at a small size, so the wallet shows standing use rather than a single visit',
  risk: 'smart-contract risk in a protocol whose token does not yet price that risk for you',
};

/**
 * A protocol's farm plan: five steps, each an action with its cost and time, derived from the
 * protocol's own category, chains, TVL and age, never from a hand-written list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const book = PLAYBOOKS[p.category ?? ''] ?? FALLBACK;
  const chain = p.chains[0] ?? 'Ethereum';
  const gas = gasFor(chain);
  const capital = capitalFor(p.tvl_usd);
  const hold = holdDaysFor(age);
  const multi = p.chains.length > 1 ? ` It runs on ${p.chains.length} chains; farm it on ${chain}, where gas is cheapest to repeat.` : '';
  const steps = [
    `Set up one fresh wallet for ${p.name} and fund it on ${gas.label} with the position money plus gas; keep the seed phrase offline and never farm from a wallet that holds your savings. Cost: about $${gas.roundTrip} of gas to open the first position. Time: 10 minutes.`,
    `${book.position(p.name, chain, capital)}${multi} Cost: $${capital} of capital plus about $${gas.roundTrip} of gas. Time: 15 minutes to set up.`,
    `Stay active: ${book.activity}. Cost: about $${gas.weekly} of gas a week. Time: 10 minutes a week.`,
    `Hold the position for at least ${hold} days without withdrawing, so the activity stands in more than one eligibility snapshot; ${p.name} has run ${age === null ? 'for an unreported span' : `about ${Math.floor(age / 30)} months`} with no token recorded, and standing depositors are who a launch can find. Cost: the $${capital} stays in the position. Time: ${hold} days.`,
    `Watch the risk and the exit: ${book.risk}. Claim any points or allocation only from links ${p.name} itself publishes, and write the wallet, dates and transactions in a farm log. Cost: nothing to check, and never pay anyone to claim. Time: 10 minutes a month.`,
  ];
  return steps.map((s) => (s.length > 600 ? `${s.slice(0, 596)}...` : s));
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot): BoardRow[] {
  const { categories } = categoryMultiples(snapshot);
  const multiples = new Map(categories.map((c) => [c.category, c]));
  const watch = new Set(snapshot.watchlist);
  const scored = snapshot.protocols
    .filter(isRankable)
    .map((p) => ({ p, v: impliedValue(p, snapshot.as_of, multiples) }));
  scored.sort((a, b) => b.v.implied - a.v.implied || b.p.tvl_usd - a.p.tvl_usd || (a.p.slug < b.p.slug ? -1 : 1));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    listed_at: s.p.listed_at,
    age_days: s.v.age,
    on_watchlist: watch.has(s.p.slug),
    implied_value_usd: s.v.implied,
    model: {
      category_multiple: s.v.multiple,
      category_comps: s.v.comps,
      growth_factor: round4(s.v.gf),
      track_factor: round4(s.v.tf),
    },
    farm_steps: farmSteps(s.p, s.v.age),
  }));
}

/** The traded set, by market cap: the comparables the multiples came from, shown at market value. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)
    .sort((a, b) => b.mcap_usd! - a.mcap_usd! || (a.slug < b.slug ? -1 : 1))
    .slice(0, 40)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      symbol: p.symbol,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
      ratio: round4(clamp(p.mcap_usd! / p.tvl_usd, MODEL.ratio_floor, MODEL.ratio_cap)),
      change_7d: p.change_7d,
    }));
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot);
  const { globalMedian, categories } = categoryMultiples(snapshot);
  const live = liveRows(snapshot);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    protocol_count: snapshot.protocols.length,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    live_size: live.length,
    total_implied_usd: board.reduce((n, r) => n + r.implied_value_usd, 0),
    global_median_ratio: round4(globalMedian),
    categories: categories.filter((c) => c.comps > 0 || board.some((r) => (r.category ?? 'Uncategorised') === c.category)),
    rows: board,
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared value, farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside 100..4000`;
  const slugs = new Set(board.map((r) => r.slug));
  if (slugs.size !== board.length) return 'a slug appears twice on the board';
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
