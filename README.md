# Launch Radar — token-launch-radar

A token launch radar for the make.fun [token-radar-01](https://make.fun/bounty/token-radar-01) bounty: it reads the sealed DefiLlama snapshot of 758 protocols, finds every protocol that records no token yet and is not a wrapped, staked or bridged product of one that trades, ranks those 198 protocols by what their launch would be worth, and hands in a static dashboard — the ranked board, a detail view for each protocol, and filters — with a concrete farm plan for every row.

![competition](https://make.fun/badge/token-radar-01.svg)
![rank](https://make.fun/badge/token-radar-01/srakart28/token-launch-radar/rank.svg)
![reward](https://make.fun/badge/token-radar-01/srakart28/token-launch-radar/reward.svg)

## Run it

Node 22, standard library only, no network:

```
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <kit>/input/snapshot.json
```

`main.ts` writes `out/board.json` (the ranked board), `out/data.js` (the dashboard's dataset), `out/dashboard/` and `out/screenshots/` (copied from this repository), and `out/dossier.json` (built with `buildDossier` from `vendor/makefun-board.ts`, copied unchanged from the kit). Open `out/dashboard/index.html` in a browser to use the board. The run is deterministic: the same snapshot always writes the same bytes.

## The value model (launch-radar-2)

A protocol's implied value is what a token would be worth if the protocol's record stayed as it is. It is built only from the snapshot's own figures:

```
implied value = TVL x category multiple x growth factor x track-record factor
```

1. **Category multiple.** Protocols whose token already trades are the comparables: the snapshot gives each a market cap and a TVL, so their market-cap-to-TVL ratio is a fact of the snapshot, not an opinion. Each ratio is winsorised to [0.01, 10] so one broken record cannot move a median. A category's multiple is the median of its comparables' ratios, shrunk toward the global median with a prior weight of 4 protocols — (n × category median + 4 × global median) / (n + 4) — and clamped to [0.02, 3]. A category with no traded comparable takes the global median. A lending market is therefore priced like lending markets and an exchange like exchanges, never by one flat rate for all.
2. **Growth factor.** 1 + 0.30 × clamp(7-day TVL change, −50%, +100%) / 100, a factor between 0.85 and 1.30. One week of TVL movement is a momentum signal, damped on purpose; an unreported change counts as zero.
3. **Track-record factor.** 0.80 + 0.35 × (1 − exp(−age in days / 540)), rising from 0.80 toward 1.15 and saturating near four years. Age is the days from DefiLlama's `listed_at` to the snapshot's `as_of`; an unreported age counts as 365 days.

No protocol name is ever special-cased: the same functions in `lib/model.ts` score every row, and the comparables are recomputed from the snapshot on every run, so the same program re-run on a future snapshot re-derives its own board.

**Who is ranked.** Every protocol that records no token (no CoinGecko id, no symbol, no market cap) and is not a wrapped, staked or bridged product of one that trades — the house watchlist's own exclusions (Bridge, Canonical Bridge, Liquid Staking, Liquid Restaking, Restaked BTC and CEX categories, version-marked names, names carrying the words wrapped, staked or staking, exchange-prefixed names) applied to the whole snapshot, not only above the $50M watchlist floor. That gives 198 rows, all 40 watchlist protocols among them. Traded protocols are never ranked; the dashboard's Model view shows them at the market's own values, as the comparables the multiples came from.

**Limits, stated plainly.** Market cap is not fully diluted value; the snapshot carries no supply, revenue or user counts, so the model uses none. Implied value is not a probability that a launch happens: several protocols on the board may never issue a token, and a protocol may record no token while having one DefiLlama does not carry — the board says a protocol *records* no token, never that it has none.

## Farm plans

Each row's plan has five steps, assembled from the protocol's own record: its category sets the position (supply and borrow for lending, provide liquidity for a DEX, deposit into a curated vault for a risk curator, and so on) and the standing risk; its first chain sets where the work happens and what gas costs; its TVL sets the capital a meaningful position needs ($50–$500); its age sets how long the position must be held to stand in more than one eligibility snapshot (30–60 days). Every step states its cost and its time.

## Layout

- `main.ts` — the program: snapshot in, board, data, dashboard, screenshots and dossier out.
- `lib/model.ts` — the model: universe split, comparables and multiples, the three factors, the farm-plan playbook, board validation.
- `vendor/makefun-board.ts` — the kit's dossier library, copied unchanged.
- `dashboard/` — hand-written vanilla HTML/CSS/JS (`index.html`, `app.css`, `app.js`); renders from `data.js` with no network. Views ride in the URL query (`?cat=Lending`, `?view=detail&slug=gauntlet`, `?view=model`), so any view can be linked or captured as-is.
- `screenshots/` — the board, one protocol's detail view, and a filtered view, captured from the page itself.

MIT licensed — see `LICENSE`.
