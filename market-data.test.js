import test from "node:test";
import assert from "node:assert/strict";
import { toAlpha, currencyOf, parseDaily, classifyError, summarize, createMarketService } from "./market-data.js";

// Build an Alpha Vantage-shaped payload from a list of closes (oldest first).
const payload = (closes, start = "2026-01-01") => {
  const ts = {};
  closes.forEach((c, i) => {
    const d = new Date(Date.parse(start) + i * 86400e3).toISOString().slice(0, 10);
    ts[d] = { "1. open": c, "2. high": c + 1, "3. low": c - 1, "4. close": c, "5. volume": 1 };
  });
  return { "Meta Data": {}, "Time Series (Daily)": ts };
};

test("toAlpha maps Canadian suffixes and rejects junk", () => {
  assert.equal(toAlpha("xeqt.to"), "XEQT.TRT");
  assert.equal(toAlpha("ABC.V"), "ABC.TRV");
  assert.equal(toAlpha("AAPL"), "AAPL");
  assert.equal(toAlpha("VFV", true), "VFV.TRT"); // Canadian holding with no suffix
  assert.equal(toAlpha("AAPL.TRT"), "AAPL.TRT");
  assert.equal(toAlpha("bad symbol!"), null);
  assert.equal(toAlpha("https://evil"), null);
  assert.equal(toAlpha(""), null);
  assert.equal(currencyOf("XEQT.TRT"), "CAD");
  assert.equal(currencyOf("AAPL"), "USD");
});

test("parseDaily sorts ascending and drops bad rows", () => {
  const p = payload([10, 11, 12]);
  p["Time Series (Daily)"]["2026-02-01"] = { "1. open": "x", "2. high": "x", "3. low": "x", "4. close": "x" };
  const s = parseDaily(p);
  assert.equal(s.length, 3);
  assert.deepEqual(s.map((x) => x.close), [10, 11, 12]);
  assert.equal(parseDaily({ Information: "hi" }), null);
});

test("classifyError recognises limits, bad symbols and junk", () => {
  assert.equal(classifyError(payload([1, 2])), null);
  assert.equal(classifyError({ Information: "Our standard API rate limit is 25 requests per day." }), "daily_limit");
  assert.equal(classifyError({ "Error Message": "Invalid API call. Please retry" }), "not_found");
  // the "slow down" reply also mentions the 25/day limit, but it is NOT the daily limit
  assert.equal(classifyError({ Information: "Please consider spreading out your free API requests more sparingly (1 request per second). You may subscribe to any of the premium plans to lift the free key rate limit (25 requests per day)" }), "burst");
  assert.equal(classifyError({ Information: "Thank you for using Alpha Vantage! Our standard API rate limit is 25 requests per day. Please subscribe to any of the premium plans to instantly remove all daily rate limits." }), "daily_limit");
  assert.equal(classifyError({ Information: "This is a premium endpoint. You may subscribe to any of the premium plans to unlock all premium endpoints." }), "premium");
  assert.equal(classifyError({}), "unavailable");
});

test("summarize: changes, range and volatility", () => {
  const closes = Array.from({ length: 100 }, (_, i) => 100 + i); // steadily rising
  const s = summarize(parseDaily(payload(closes)));
  assert.equal(s.last, 199);
  assert.ok(Math.abs(s.change1m - (199 / 178 - 1)) < 1e-12); // 21 trading days back
  assert.ok(Math.abs(s.change3m - (199 / 136 - 1)) < 1e-12);
  assert.equal(s.high, 200);
  assert.equal(s.low, 99);
  assert.ok(s.rangePos > 0.98 && s.rangePos <= 1);
  assert.ok(s.volatility > 0);
  assert.equal(summarize(parseDaily(payload([5]))), null);
  // not enough history for a 3-month change -> null, not a wrong number
  assert.equal(summarize(parseDaily(payload(Array.from({ length: 30 }, (_, i) => 10 + i)))).change3m, null);
  // flat prices -> zero volatility, no divide-by-zero range
  const flat = summarize([{ date: "a", close: 5, high: 5, low: 5 }, { date: "b", close: 5, high: 5, low: 5 }]);
  assert.equal(flat.volatility, 0);
  assert.equal(flat.rangePos, null);
});

const mkService = (over = {}) => {
  let calls = 0, t = Date.parse("2026-09-20T12:00:00Z");
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); t += ms; };
  const fetchFn = over.fetchFn || (async () => { calls++; return { json: async () => payload(Array.from({ length: 100 }, (_, i) => 50 + i)) }; });
  const svc = createMarketService({ apiKey: "K", fetchFn, now: () => t, sleep, limit: over.limit ?? 3, ttlMs: 1000, ...over });
  return { svc, calls: () => calls, advance: (ms) => (t += ms), sleeps };
};

test("service: cached answers cost nothing; expiry refetches", async () => {
  const { svc, calls, advance } = mkService();
  const a = await svc.get("AAPL");
  assert.equal(a.ok, true); assert.equal(a.cached, false); assert.equal(a.budget.used, 1);
  const b = await svc.get("aapl");
  assert.equal(b.cached, true); assert.equal(calls(), 1); assert.equal(b.budget.used, 1);
  advance(2000);
  assert.equal((await svc.get("AAPL")).cached, false);
  assert.equal(calls(), 2);
});

test("service: concurrent requests for one symbol share a single lookup", async () => {
  const { svc, calls } = mkService();
  await Promise.all([svc.get("AAPL"), svc.get("AAPL"), svc.get("AAPL")]);
  assert.equal(calls(), 1);
});

test("service: peek never spends a lookup", async () => {
  const { svc, calls } = mkService();
  const miss = await svc.get("AAPL", { peek: true });
  assert.deepEqual([miss.ok, miss.error, calls()], [false, "not_cached", 0]);
  await svc.get("AAPL");
  assert.equal((await svc.get("AAPL", { peek: true })).ok, true);
});

test("service: stops at the daily limit, serves stale cache, resets next day", async () => {
  const { svc, calls, advance } = mkService({ limit: 2 });
  await svc.get("A"); await svc.get("B");
  const blocked = await svc.get("C");
  assert.deepEqual([blocked.ok, blocked.error, calls()], [false, "daily_limit", 2]);
  advance(5000); // A's cache is now stale, but we're out of lookups: stale beats nothing
  const stale = await svc.get("A");
  assert.deepEqual([stale.ok, stale.stale], [true, true]);
  advance(24 * 3600e3);
  assert.equal((await svc.get("C")).ok, true);
});

test("service: provider limit message locks the budget; bad symbol is cached negatively", async () => {
  const lim = mkService({ fetchFn: async () => ({ json: async () => ({ Information: "standard API rate limit is 25 requests per day" }) }) });
  const r = await lim.svc.get("AAPL");
  assert.equal(r.error, "daily_limit");
  assert.equal(r.budget.used, r.budget.limit);
  let n = 0;
  const bad = mkService({ fetchFn: async () => { n++; return { json: async () => ({ "Error Message": "Invalid API call" }) }; } });
  assert.equal((await bad.svc.get("ZZZZ")).error, "not_found");
  assert.equal((await bad.svc.get("ZZZZ")).error, "not_found");
  assert.equal(n, 1); // second answer came from the negative cache
});

test("service: no key, bad symbol and network failure are reported, not thrown", async () => {
  assert.equal((await createMarketService({ apiKey: "" }).get("AAPL")).error, "no_key");
  const { svc } = mkService();
  assert.equal((await svc.get("bad symbol!")).error, "bad_symbol");
  const down = mkService({ fetchFn: async () => { throw new Error("offline"); } });
  assert.equal((await down.svc.get("AAPL")).error, "unavailable");
});

test("service: cache is persisted through the store", async () => {
  let saved = null;
  const store = { load: () => saved ?? {}, save: (s) => (saved = JSON.parse(JSON.stringify(s))) };
  const { svc } = mkService({ store });
  await svc.get("AAPL");
  assert.ok(saved.cache["AAPL"]);
  const again = mkService({ store, fetchFn: async () => { throw new Error("should not be called"); } });
  assert.equal((await again.svc.get("AAPL")).cached, true);
});

const BURST = { Information: "Please consider spreading out your free API requests more sparingly (1 request per second). You may subscribe to any of the premium plans to lift the free key rate limit (25 requests per day)." };

test("service: two lookups in a row are spaced out (the bug: the 2nd one was rejected)", async () => {
  const times = [];
  let t = Date.parse("2026-09-20T12:00:00Z");
  const svc = createMarketService({
    apiKey: "K", now: () => t, sleep: async (ms) => { t += ms; }, limit: 25,
    fetchFn: async () => { times.push(t); return { json: async () => payload(Array.from({ length: 100 }, (_, i) => 50 + i)) }; },
  });
  await Promise.all([svc.get("HXQ.TO", { cad: true }), svc.get("AAPL")]);
  assert.equal(times.length, 2);
  assert.ok(times[1] - times[0] >= 1100, "requests must be at least 1.1s apart, got " + (times[1] - times[0]));
});

test("service: a 'slow down' reply is retried once, not treated as the daily limit", async () => {
  let n = 0;
  const { svc, sleeps } = mkService({ fetchFn: async () => { n++; return { json: async () => (n === 1 ? BURST : payload(Array.from({ length: 100 }, (_, i) => 50 + i))) }; } });
  const r = await svc.get("AAPL");
  assert.equal(r.ok, true);
  assert.equal(n, 2);
  assert.equal(r.budget.used, 1); // one lookup, however many attempts it took
  assert.ok(sleeps.some((ms) => ms >= 1000));
});

test("service: if it keeps saying 'slow down', report busy, refund the lookup, never lock the budget", async () => {
  const { svc } = mkService({ limit: 5, fetchFn: async () => ({ json: async () => BURST }) });
  const r = await svc.get("AAPL");
  assert.deepEqual([r.ok, r.error], [false, "busy"]);
  assert.equal(r.budget.used, 0);
  const again = await svc.get("MSFT");
  assert.equal(again.error, "busy"); // still retryable: not "daily_limit"
});

test("service: a premium-only ticker is reported as such and does not lock the budget", async () => {
  const { svc } = mkService({ limit: 5, fetchFn: async () => ({ json: async () => ({ Information: "This is a premium endpoint. You may subscribe to any of the premium plans." }) }) });
  const r = await svc.get("XYZ");
  assert.equal(r.error, "premium");
  assert.ok(r.budget.used < 5);
});
