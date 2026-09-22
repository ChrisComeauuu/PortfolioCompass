// Pure helpers for the "Head to head" card. No DOM access, so they can be unit tested in Node.

// Aggregate positions by ticker across the given (visible) accounts.
// conv(amount, fromCurrency) converts to the display currency; total is the whole portfolio
// value (holdings + cash) in that same currency; isRegistered(account) flags TFSA/FHSA/RRSP.
export function buildHoldings(accounts, conv, isRegistered, total) {
  const byTicker = new Map();
  for (const a of accounts) {
    const registered = isRegistered(a);
    for (const p of a.positions) {
      const value = conv(p.value, p.currency);
      let h = byTicker.get(p.ticker);
      if (!h) {
        h = { ticker: p.ticker, currency: p.currency, kind: p.kind || null, name: p.name || "", value: 0, cost: 0, units: 0, price: conv(p.price, p.currency), registeredValue: 0, accountIds: new Set(), pnl: null };
        byTicker.set(p.ticker, h);
      }
      h.value += value;
      h.units += p.units;
      h.accountIds.add(a.id);
      if (registered) h.registeredValue += value;
      if (!h.name && p.name) h.name = p.name;
      if (!h.kind && p.kind) h.kind = p.kind;
      if (p.pnl != null) {
        const pnl = conv(p.pnl, p.currency);
        h.pnl = (h.pnl ?? 0) + pnl;
        h.cost += value - pnl; // what was paid = value minus the gain
      }
    }
  }
  return [...byTicker.values()]
    .map((h) => ({
      ticker: h.ticker,
      owned: true,
      currency: h.currency,
      kind: h.kind,
      name: h.name,
      value: h.value,
      weight: total > 0 ? h.value / total : 0,
      units: h.units,
      price: h.price,
      accounts: h.accountIds.size,
      registeredShare: h.value > 0 ? h.registeredValue / h.value : 0,
      pnl: h.pnl,
      gainPct: h.pnl != null && h.cost > 0 ? h.pnl / h.cost : null,
    }))
    .sort((x, y) => y.value - x.value);
}

const EPS = 1e-9;
const edgeOf = (a, b) => (Math.abs(a - b) < EPS ? "tie" : a > b ? "a" : "b");

const KIND_LABEL = { stock: "Stock", etf: "ETF", mutualfund: "Mutual fund", crypto: "Crypto", cef: "Closed-end fund", adr: "ADR", bond: "Bond", option: "Option" };
export const kindLabel = (k) => KIND_LABEL[k] || (k ? k[0].toUpperCase() + k.slice(1) : null);

// Where a ticker is listed, from its suffix (SnapTrade: XEQT.TO, Alpha Vantage: XEQT.TRT).
export function listing(ticker) {
  if (/\.(TO|TRT)$/i.test(ticker)) return "TSX";
  if (/\.(V|TRV)$/i.test(ticker)) return "TSX Venture";
  return "US / other";
}

// Compare two fighters row by row. A fighter is either one of your holdings (owned: true, from
// buildHoldings) or an outside ticker (owned: false). `market` holds optional Alpha Vantage stats.
// `edge` is which side leads a row, "tie", or null for information-only rows. Rows that can't be
// compared fairly (missing on either side) are left out instead of being shown as zero.
export function compare(a, b) {
  const rows = [];
  const add = (key, label, kind, va, vb, edge, extra = {}) => rows.push({ key, label, kind, a: va, b: vb, edge, ...extra });
  const both = (va, vb) => va != null && vb != null;
  const owned = a.owned && b.owned;

  if (owned) {
    add("value", "Position value", "money", a.value, b.value, edgeOf(a.value, b.value));
    add("weight", "Share of your portfolio", "pct", a.weight, b.weight, edgeOf(a.weight, b.weight));
    add("registered", "Held in TFSA / FHSA / RRSP", "pct", a.registeredShare, b.registeredShare, edgeOf(a.registeredShare, b.registeredShare));
    if (both(a.pnl, b.pnl)) add("pnl", "Gain / loss", "signed", a.pnl, b.pnl, edgeOf(a.pnl, b.pnl));
    if (both(a.gainPct, b.gainPct)) add("gainPct", "Gain / loss (%)", "spct", a.gainPct, b.gainPct, edgeOf(a.gainPct, b.gainPct));
  }
  if (both(a.kind, b.kind)) add("type", "Type", "text", kindLabel(a.kind), kindLabel(b.kind), null);
  add("listing", "Listed on", "text", listing(a.ticker), listing(b.ticker), null);

  const ma = a.market, mb = b.market;
  if (ma && mb) {
    add("close", "Latest close", "close", ma.last, mb.last, null, { curA: ma.currency, curB: mb.currency });
    if (both(ma.change1m, mb.change1m)) add("change1m", "1-month change", "spct", ma.change1m, mb.change1m, edgeOf(ma.change1m, mb.change1m));
    if (both(ma.change3m, mb.change3m)) add("change3m", "3-month change", "spct", ma.change3m, mb.change3m, edgeOf(ma.change3m, mb.change3m));
    add("volatility", "Volatility (annualised)", "pct", ma.volatility, mb.volatility, null);
    if (both(ma.rangePos, mb.rangePos)) add("rangePos", "Position in ~100-day range", "pct", ma.rangePos, mb.rangePos, null);
  }
  if (owned) {
    add("price", "Share price", "money", a.price, b.price, null);
    add("units", "Units held", "units", a.units, b.units, null);
    add("accounts", "Accounts holding it", "count", a.accounts, b.accounts, null);
  }

  const tally = { a: 0, b: 0, tie: 0, compared: 0 };
  for (const r of rows) if (r.edge) { tally[r.edge]++; tally.compared++; }
  return { rows, tally };
}

// Pick a stored/default pair, falling back to the two largest holdings.
export function pickPair(holdings, storedA, storedB) {
  const has = (t) => holdings.some((h) => h.ticker === t);
  if (holdings.length < 2) return null;
  let a = has(storedA) ? storedA : holdings[0].ticker;
  let b = has(storedB) && storedB !== a ? storedB : holdings.find((h) => h.ticker !== a).ticker;
  return [a, b];
}

// Random pair of distinct tickers.
export function shufflePair(holdings, rand = Math.random) {
  if (holdings.length < 2) return null;
  const i = Math.floor(rand() * holdings.length);
  let j = Math.floor(rand() * (holdings.length - 1));
  if (j >= i) j++;
  return [holdings[i].ticker, holdings[j].ticker];
}
