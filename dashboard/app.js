// Launch Radar page: renders window.RADAR (written by main.ts beside this page)
// with no network, no framework and no fetch. Three views: the ranked board,
// one protocol's detail, and the model with its traded comparables. Filters
// and the open view ride in the URL query (?cat=, ?chain=, ?q=, ?watch=1,
// ?sort=, ?view=detail&slug=), so any view can be linked or captured as-is.

const R = window.RADAR;
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** $1.24B / $312.5M / $45.2K / $980. */
function money(n) {
  if (n === null || n === undefined) return '—';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n}`;
}

/** $1,234,567,890 for the detail view. */
const moneyFull = (n) => (n === null || n === undefined ? '—' : `$${n.toLocaleString('en-US')}`);

/** A signed per-cent, coloured by sign. */
function pct(n) {
  if (n === null || n === undefined) return '<span class="flat">—</span>';
  const cls = n > 0.05 ? 'pos' : n < -0.05 ? 'neg' : 'flat';
  return `<span class="${cls}">${n > 0 ? '+' : ''}${n.toFixed(1)}%</span>`;
}

/** 142 d / 14 mo / 3.2 yrs from a day count. */
function ageLabel(days) {
  if (days === null || days === undefined) return '—';
  if (days >= 730) return `${(days / 365.25).toFixed(1)} yrs`;
  if (days >= 60) return `${Math.round(days / 30.44)} mo`;
  return `${days} d`;
}

/** First two chains, then +n. */
function chainsLabel(chains) {
  if (!chains || chains.length === 0) return '—';
  return chains.length <= 2 ? chains.join(', ') : `${chains[0]}, ${chains[1]} +${chains.length - 2}`;
}

const bySlug = new Map(R.rows.map((r) => [r.slug, r]));

/* ------------------------------------------------ header stats */

function renderStats() {
  const watch = R.rows.filter((r) => r.on_watchlist).length;
  $('stats').innerHTML =
    `<span><b>${R.board_size}</b> protocols ranked</span>` +
    `<span><b>${watch}</b> on the house watchlist</span>` +
    `<span>combined implied <b class="hl">${money(R.total_implied_usd)}</b></span>` +
    `<span>snapshot <b>${esc(R.as_of)}</b> · ${R.protocol_count} protocols read</span>` +
    `<span>model <b>${esc(R.model_version)}</b></span>`;
  $('source-line').innerHTML = `<span class="src">Source: ${esc(R.source)}. Watchlist floor: ${money(R.floor_usd)} TVL.</span>`;
}

/* ------------------------------------------------ the board */

const state = {
  q: params.get('q') ?? '',
  cat: params.get('cat') ?? '',
  chain: params.get('chain') ?? '',
  watch: params.get('watch') === '1',
  sort: params.get('sort') ?? 'implied',
};

function fillSelect(el, values, allLabel, current) {
  el.innerHTML = `<option value="">${allLabel}</option>` + values.map((v) => `<option${v === current ? ' selected' : ''}>${esc(v)}</option>`).join('');
}

function filteredRows() {
  let rows = R.rows.filter((r) => {
    if (state.watch && !r.on_watchlist) return false;
    if (state.cat && (r.category ?? 'Uncategorised') !== state.cat) return false;
    if (state.chain && !r.chains.includes(state.chain)) return false;
    if (state.q) {
      const q = state.q.toLowerCase();
      if (!r.name.toLowerCase().includes(q) && !r.slug.includes(q)) return false;
    }
    return true;
  });
  const by = {
    implied: (a, b) => a.rank - b.rank,
    tvl: (a, b) => b.tvl_usd - a.tvl_usd,
    growth: (a, b) => (b.change_7d ?? -Infinity) - (a.change_7d ?? -Infinity),
    age: (a, b) => (b.age_days ?? -1) - (a.age_days ?? -1),
    multiple: (a, b) => b.model.category_multiple - a.model.category_multiple,
  }[state.sort] ?? ((a, b) => a.rank - b.rank);
  return rows.sort(by);
}

function renderBoard() {
  const rows = filteredRows();
  $('count').textContent =
    `Showing ${rows.length} of ${R.board_size} ranked protocols` +
    (state.cat ? ` · category ${state.cat}` : '') +
    (state.chain ? ` · on ${state.chain}` : '') +
    (state.watch ? ' · watchlist only' : '') +
    (state.q ? ` · matching "${state.q}"` : '') +
    ` · sorted by ${$('sort').selectedOptions[0].textContent.toLowerCase()}`;
  $('rows').innerHTML = rows
    .map(
      (r) => `<tr data-slug="${esc(r.slug)}"${r.rank <= 3 ? ' class="top3"' : ''}>
        <td class="num rank">${r.rank}</td>
        <td class="name">${esc(r.name)}${r.on_watchlist ? '<span class="badge">WATCHLIST</span>' : ''}<span class="slug">${esc(r.slug)}</span></td>
        <td class="cat">${esc(r.category ?? '—')}</td>
        <td class="chains">${esc(chainsLabel(r.chains))}</td>
        <td class="num">${money(r.tvl_usd)}</td>
        <td class="num">${pct(r.change_7d)}</td>
        <td class="num">${ageLabel(r.age_days)}</td>
        <td class="num">${r.model.category_multiple.toFixed(2)}x</td>
        <td class="num implied">${money(r.implied_value_usd)}</td>
      </tr>`,
    )
    .join('');
  for (const tr of $('rows').querySelectorAll('tr')) {
    tr.addEventListener('click', () => openDetail(tr.dataset.slug));
  }
}

/* ------------------------------------------------ detail view */

function bar(label, value, max, shown) {
  const w = Math.max(2, Math.min(100, (value / max) * 100));
  return `<div class="bar-row"><span class="bl">${label}</span><span class="bar"><i style="width:${w}%"></i></span><span class="bv">${shown}</span></div>`;
}

function openDetail(slug) {
  const r = bySlug.get(slug);
  if (!r) return show('board');
  const m = r.model;
  $('detail').innerHTML = `
    <div class="detail-head">
      <h2>${esc(r.name)}${r.on_watchlist ? '<span class="badge">WATCHLIST</span>' : ''}</h2>
      <p class="sub">${esc(r.slug)} · ${esc(r.category ?? 'Uncategorised')} · records no token in the ${esc(R.as_of)} snapshot</p>
    </div>
    <div class="grid">
      <div class="stat"><div class="k">Rank</div><div class="v">#${r.rank} of ${R.board_size}</div><div class="n">by implied value</div></div>
      <div class="stat"><div class="k">Implied launch value</div><div class="v big">${moneyFull(r.implied_value_usd)}</div><div class="n">the model's claim, not a forecast</div></div>
      <div class="stat"><div class="k">TVL</div><div class="v">${moneyFull(r.tvl_usd)}</div><div class="n">across ${r.chains.length} chain${r.chains.length === 1 ? '' : 's'}</div></div>
      <div class="stat"><div class="k">7d TVL change</div><div class="v">${r.change_7d === null ? '—' : `${r.change_7d > 0 ? '+' : ''}${r.change_7d.toFixed(1)}%`}</div><div class="n">one week, damped in the model</div></div>
      <div class="stat"><div class="k">Track record</div><div class="v">${r.age_days === null ? 'unreported' : `${r.age_days.toLocaleString('en-US')} days`}</div><div class="n">tracked since ${esc(r.listed_at ?? '—')}, no token recorded</div></div>
      <div class="stat"><div class="k">Chains</div><div class="v" style="font-size:13px;line-height:1.5">${esc(r.chains.join(', ') || '—')}</div><div class="n">as DefiLlama counts its TVL</div></div>
    </div>
    <div class="panel">
      <h3>How this value is built</h3>
      <p class="formula">implied = TVL x category multiple x growth factor x track-record factor</p>
      ${bar(`Category multiple · ${esc(r.category ?? 'Uncategorised')}`, m.category_multiple, 3, `${m.category_multiple.toFixed(2)}x · ${m.category_comps} traded comp${m.category_comps === 1 ? '' : 's'}`)}
      ${bar('Growth factor', m.growth_factor, 1.3, `${m.growth_factor.toFixed(2)}x · 7d ${r.change_7d === null ? 'unreported' : `${r.change_7d.toFixed(1)}%`}`)}
      ${bar('Track-record factor', m.track_factor, 1.15, `${m.track_factor.toFixed(2)}x · ${r.age_days === null ? 'age counted as 365 d' : `${r.age_days} days`}`)}
      <p>${moneyFull(r.tvl_usd)} x ${m.category_multiple.toFixed(2)} x ${m.growth_factor.toFixed(2)} x ${m.track_factor.toFixed(2)} = <b>${moneyFull(r.implied_value_usd)}</b>. The multiple is the median market-cap-to-TVL of traded ${esc(r.category ?? '')} protocols in this same snapshot, shrunk toward the global median of ${R.global_median_ratio.toFixed(2)}x; see Model &amp; comparables.</p>
    </div>
    <div class="panel">
      <h3>Farm plan — ${esc(r.name)}</h3>
      <ol class="plan">${r.farm_steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
    </div>`;
  show('detail');
  const url = new URL(location.href);
  url.searchParams.set('view', 'detail');
  url.searchParams.set('slug', slug);
  history.replaceState(null, '', url);
  window.scrollTo(0, 0);
}

/* ------------------------------------------------ model view */

function renderModel() {
  const catRows = R.categories
    .map(
      (c) => `<tr class="static"><td>${esc(c.category)}</td><td class="num">${c.comps}</td><td class="num">${c.median_ratio === null ? '—' : `${c.median_ratio.toFixed(2)}x`}</td><td class="num implied">${c.multiple.toFixed(2)}x</td></tr>`,
    )
    .join('');
  const liveRows = R.live
    .map(
      (p, i) => `<tr class="static"><td class="num rank">${i + 1}</td><td class="name">${esc(p.name)}<span class="slug">${esc(p.symbol ?? '')}</span></td><td class="cat">${esc(p.category ?? '—')}</td><td class="num">${money(p.tvl_usd)}</td><td class="num">${money(p.mcap_usd)}</td><td class="num">${p.ratio.toFixed(2)}x</td></tr>`,
    )
    .join('');
  $('model').innerHTML = `
    <div class="panel">
      <h3>The value model — ${esc(R.model_version)}</h3>
      <p class="formula">implied value = TVL x category multiple x growth factor x track-record factor</p>
      <p><b>Category multiple.</b> Protocols whose token already trades are the comparables: the snapshot gives each a market cap and a TVL, so their market-cap-to-TVL ratio is a fact of the snapshot. Each ratio is winsorised to [0.01, 10] so one broken record cannot move a median. A category's multiple is the median of its comparables' ratios, shrunk toward the global median (${R.global_median_ratio.toFixed(2)}x) with a prior weight of 4 protocols: (n x category median + 4 x global median) / (n + 4). A category with no traded comparable takes the global median. Multiples are clamped to [0.02, 3]. A lending market is therefore priced like lending markets and an exchange like exchanges, never by one flat rate for all.</p>
      <p><b>Growth factor.</b> 1 + 0.30 x clamp(7d TVL change, -50%, +100%) / 100 — between 0.85 and 1.30. One week of TVL movement is a momentum signal, damped on purpose; an unreported change counts as zero.</p>
      <p><b>Track-record factor.</b> 0.80 + 0.35 x (1 - exp(-age in days / 540)), rising from 0.80 toward 1.15 and saturating near four years. A protocol that has run longer at size with no token has the deeper record a launch would be priced on. An unreported age counts as 365 days.</p>
      <p><b>Who is ranked.</b> Every protocol in the snapshot that records no token (no CoinGecko id, no symbol, no market cap) and is not a wrapped, staked or bridged product of one that trades: the house watchlist's own exclusions (Bridge, Canonical Bridge, Liquid Staking, Liquid Restaking, Restaked BTC and CEX categories, version-marked names, names carrying the words wrapped, staked or staking, and exchange-prefixed names) applied to the whole snapshot, not only above the ${money(R.floor_usd)} watchlist floor. That gives ${R.board_size} rows, all ${R.watchlist_size} watchlist protocols among them. Traded protocols are never ranked; they appear below at the market's own values, as the comparables.</p>
      <p><b>Limits, stated plainly.</b> Market cap is not fully diluted value; the snapshot carries no supply, revenue or user counts, so the model uses none. Implied value says what a launch would be worth if the record stayed as it is — it is not a probability that a launch happens, and several protocols here may never issue a token, or may record none while having one DefiLlama does not carry.</p>
    </div>
    <div class="cols">
      <div class="panel">
        <h3>Category multiples, from this snapshot</h3>
        <table class="model-table"><thead><tr><th>Category</th><th class="num">Traded comps</th><th class="num">Median ratio</th><th class="num">Multiple used</th></tr></thead><tbody>${catRows}</tbody></table>
      </div>
      <div class="panel">
        <h3>The traded set — comparables at market value</h3>
        <table class="model-table"><thead><tr><th class="num">#</th><th>Protocol</th><th>Category</th><th class="num">TVL</th><th class="num">Market cap</th><th class="num">Cap / TVL</th></tr></thead><tbody>${liveRows}</tbody></table>
      </div>
    </div>`;
}

/* ------------------------------------------------ view switching */

function show(view) {
  document.body.classList.toggle('detail-open', view === 'detail');
  $('view-board').hidden = view !== 'board';
  $('view-detail').hidden = view !== 'detail';
  $('view-model').hidden = view !== 'model';
  $('tab-board').classList.toggle('on', view !== 'model');
  $('tab-model').classList.toggle('on', view === 'model');
  if (view === 'board') {
    const url = new URL(location.href);
    url.searchParams.delete('view');
    url.searchParams.delete('slug');
    history.replaceState(null, '', url);
  }
  window.scrollTo(0, 0);
}

function init() {
  renderStats();
  renderModel();
  const cats = [...new Set(R.rows.map((r) => r.category ?? 'Uncategorised'))].sort();
  const chains = [...new Set(R.rows.flatMap((r) => r.chains))].sort();
  fillSelect($('cat'), cats, 'All categories', state.cat);
  fillSelect($('chain'), chains, 'All chains', state.chain);
  $('q').value = state.q;
  $('watch').checked = state.watch;
  $('sort').value = state.sort;
  const onChange = () => {
    state.q = $('q').value.trim();
    state.cat = $('cat').value;
    state.chain = $('chain').value;
    state.watch = $('watch').checked;
    state.sort = $('sort').value;
    renderBoard();
  };
  for (const id of ['q', 'cat', 'chain', 'watch', 'sort']) $(id).addEventListener('input', onChange);
  $('rows').innerHTML = '';
  renderBoard();
  $('tab-board').addEventListener('click', () => show('board'));
  $('tab-model').addEventListener('click', () => show('model'));
  $('back').addEventListener('click', () => show('board'));
  if (params.get('view') === 'model') show('model');
  else if (params.get('view') === 'detail' && params.get('slug')) openDetail(params.get('slug'));
  else show('board');
}

init();
