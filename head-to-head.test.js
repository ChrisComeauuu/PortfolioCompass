import test from "node:test";
import assert from "node:assert/strict";
import { buildHoldings, compare, pickPair, shufflePair, listing, kindLabel } from "./public/head-to-head.js";

const P = (ticker, units, price, currency = "CAD", pnl = null, name = "", kind = null) => ({ ticker, kind, name, units, price, value: units * price, costBasis: 0, pnl, currency });
const acct = (id, type, positions) => ({ id, type, name: type, positions });
const rate = 1.4; // USD -> CAD
const conv = (n, from) => (from === "USD" ? n * rate : n);
const reg = (a) => /TFSA|FHSA|RRSP/.test(a.type);

const accounts = [
  acct("t", "TFSA", [P("XEQT", 100, 30), P("AAPL", 5, 200, "USD", 100)]),
  acct("m", "Margin", [P("XEQT", 50, 30), P("VFV", 10, 100)]),
];
const total = 3000 + 1400 + 1500 + 1000 + 500; // holdings 7400 + 500 cash... computed below

test("buildHoldings aggregates a ticker across accounts and converts currency", () => {
  const h = buildHoldings(accounts, conv, reg, 8000);
  const xeqt = h.find((x) => x.ticker === "XEQT");
  assert.equal(xeqt.value, 4500);
  assert.equal(xeqt.units, 150);
  assert.equal(xeqt.accounts, 2);
  assert.equal(xeqt.registeredShare, 3000 / 4500);
  assert.equal(h.find((x) => x.ticker === "AAPL").value, 1400); // 1000 USD -> CAD
  assert.deepEqual(h.map((x) => x.ticker), ["XEQT", "AAPL", "VFV"]); // sorted by value
  assert.equal(xeqt.weight, 4500 / 8000);
});

test("buildHoldings: pnl is null unless the broker supplied it, and converted when it did", () => {
  const h = buildHoldings(accounts, conv, reg, 8000);
  assert.equal(h.find((x) => x.ticker === "XEQT").pnl, null);
  assert.equal(h.find((x) => x.ticker === "AAPL").pnl, 140);
});

test("buildHoldings guards against a zero total", () => {
  assert.equal(buildHoldings(accounts, conv, reg, 0)[0].weight, 0);
});

test("compare: edges, info-only rows and tally", () => {
  const h = buildHoldings(accounts, conv, reg, 8000);
  const { rows, tally } = compare(h[0], h[2]); // XEQT vs VFV
  const by = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.equal(by.value.edge, "a");
  assert.equal(by.weight.edge, "a");
  assert.equal(by.registered.edge, "a"); // 66.7% vs 0%
  assert.equal(by.price.edge, null);
  assert.equal(by.units.edge, null);
  assert.equal(by.pnl, undefined); // omitted: neither side has cost data
  assert.deepEqual(tally, { a: 3, b: 0, tie: 0, compared: 3 });
});

test("compare: gain/loss row appears only when both sides have it", () => {
  const a = { ticker: "A", owned: true, value: 1, weight: 0.1, registeredShare: 0, price: 1, units: 1, accounts: 1, pnl: 50 };
  const b = { ...a, ticker: "B", pnl: null };
  assert.equal(compare(a, b).rows.some((r) => r.key === "pnl"), false);
  const c = compare(a, { ...b, pnl: 80 });
  assert.equal(c.rows.find((r) => r.key === "pnl").edge, "b");
});

test("compare: exact ties are ties", () => {
  const a = { ticker: "A", owned: true, value: 100, weight: 0.5, registeredShare: 1, price: 1, units: 1, accounts: 1, pnl: null };
  const { tally } = compare(a, { ...a, ticker: "B" });
  assert.deepEqual(tally, { a: 0, b: 0, tie: 3, compared: 3 });
});

test("pickPair: defaults to the two largest, keeps valid stored picks, never duplicates", () => {
  const h = buildHoldings(accounts, conv, reg, 8000);
  assert.deepEqual(pickPair(h, undefined, undefined), ["XEQT", "AAPL"]);
  assert.deepEqual(pickPair(h, "VFV", "AAPL"), ["VFV", "AAPL"]);
  assert.deepEqual(pickPair(h, "GONE", "ALSO_GONE"), ["XEQT", "AAPL"]);
  const same = pickPair(h, "AAPL", "AAPL");
  assert.notEqual(same[0], same[1]);
  assert.equal(pickPair(h.slice(0, 1), "XEQT", "AAPL"), null);
});

test("shufflePair returns two distinct tickers for every random value", () => {
  const h = buildHoldings(accounts, conv, reg, 8000);
  for (const r of [0, 0.34, 0.5, 0.67, 0.999]) {
    const [x, y] = shufflePair(h, () => r);
    assert.notEqual(x, y);
  }
  assert.equal(shufflePair(h.slice(0, 1)), null);
});

test("buildHoldings carries type and computes gain % from broker gain and value", () => {
  const h = buildHoldings([acct("t", "TFSA", [P("XEQT", 100, 30, "CAD", 300, "", "etf")])], conv, reg, 3000);
  assert.equal(h[0].kind, "etf");
  assert.equal(h[0].owned, true);
  assert.ok(Math.abs(h[0].gainPct - 300 / 2700) < 1e-12); // paid 2700, now 3000
  assert.equal(buildHoldings(accounts, conv, reg, 8000)[0].gainPct, null);
});

test("compare: type and listing rows; gain % gets an edge", () => {
  const base = { owned: true, value: 1, weight: 0.1, registeredShare: 0, price: 1, units: 1, accounts: 1, pnl: 10 };
  const a = { ...base, ticker: "XEQT.TO", kind: "etf", gainPct: 0.10 };
  const b = { ...base, ticker: "AAPL", kind: "stock", gainPct: 0.25 };
  const by = Object.fromEntries(compare(a, b).rows.map((r) => [r.key, r]));
  assert.deepEqual([by.type.a, by.type.b, by.type.edge], ["ETF", "Stock", null]);
  assert.deepEqual([by.listing.a, by.listing.b], ["TSX", "US / other"]);
  assert.equal(by.gainPct.edge, "b");
  // type row is left out when the broker didn't say
  assert.equal(compare({ ...a, kind: null }, b).rows.some((r) => r.key === "type"), false);
});

const mkt = (o = {}) => ({ last: 100, currency: "USD", change1m: 0.02, change3m: 0.05, volatility: 0.2, rangePos: 0.5, ...o });

test("compare: outside ticker vs holding shows market rows only, never portfolio rows", () => {
  const mine = { owned: true, ticker: "XEQT.TO", value: 5, weight: 0.5, registeredShare: 1, price: 30, units: 1, accounts: 1, pnl: null, market: mkt({ currency: "CAD", change1m: 0.03, volatility: 0.15 }) };
  const outside = { owned: false, ticker: "MSFT", name: "MSFT", kind: null, market: mkt({ change1m: 0.01, change3m: 0.09 }) };
  const { rows, tally } = compare(mine, outside);
  const keys = rows.map((r) => r.key);
  for (const k of ["value", "weight", "registered", "units", "accounts", "price"]) assert.equal(keys.includes(k), false, k);
  const by = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.equal(by.change1m.edge, "a");
  assert.equal(by.change3m.edge, "b");
  assert.equal(by.volatility.edge, null); // information only: lower isn't "better" for everyone
  assert.deepEqual([by.close.curA, by.close.curB], ["CAD", "USD"]);
  assert.deepEqual(tally, { a: 1, b: 1, tie: 0, compared: 2 });
});

test("compare: a missing market change is omitted, and no market data means no market rows", () => {
  const a = { owned: false, ticker: "A", market: mkt({ change3m: null }) };
  const b = { owned: false, ticker: "B", market: mkt() };
  assert.equal(compare(a, b).rows.some((r) => r.key === "change3m"), false);
  assert.equal(compare(a, b).rows.some((r) => r.key === "change1m"), true);
  const c = compare({ owned: false, ticker: "A" }, b);
  assert.equal(c.rows.some((r) => r.key === "close"), false);
  assert.equal(c.tally.compared, 0);
});

test("listing and kindLabel helpers", () => {
  assert.equal(listing("XEQT.TO"), "TSX");
  assert.equal(listing("XEQT.TRT"), "TSX");
  assert.equal(listing("ABC.V"), "TSX Venture");
  assert.equal(listing("AAPL"), "US / other");
  assert.equal(kindLabel("etf"), "ETF");
  assert.equal(kindLabel("weirdthing"), "Weirdthing");
  assert.equal(kindLabel(null), null);
});
