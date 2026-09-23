// Market-data helpers backed by Alpha Vantage's free TIME_SERIES_DAILY endpoint.
// The free tier allows ~25 requests/day, so everything here is built around not wasting calls:
// results are cached, in-flight requests are shared, and a persisted daily budget stops us early.

import crypto from "node:crypto";

const SUFFIX = { ".TO": ".TRT", ".V": ".TRV", ".TRT": ".TRT", ".TRV": ".TRV" };
// A short hash of the key, never the key itself — lets the counter tell "same key, new day" apart
// from "the key changed" without ever persisting or logging the real value.
const fingerprint = (key) => (key ? crypto.createHash("sha256").update(key).digest("hex").slice(0, 12) : null);

// SnapTrade/Wealthsimple write TSX tickers as XEQT.TO; Alpha Vantage wants XEQT.TRT.
export function toAlpha(symbol, cadHint = false) {
  const s = String(symbol ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9]{1,10}([.-][A-Z0-9]{1,4})?$/.test(s)) return null;
  const m = s.match(/\.[A-Z]+$/);
  if (m && SUFFIX[m[0]]) return s.slice(0, -m[0].length) + SUFFIX[m[0]];
  if (!m && cadHint) return s + ".TRT"; // Canadian holding reported without a suffix
  return s;
}
export const currencyOf = (alpha) => (/\.(TRT|TRV)$/.test(alpha) ? "CAD" : "USD");

// -> ascending [{ date, close, high, low }], or null when the payload isn't a price series.
export function parseDaily(json) {
  const raw = json?.["Time Series (Daily)"];
  if (!raw || typeof raw !== "object") return null;
  const out = Object.entries(raw)
    .map(([date, v]) => ({ date, close: parseFloat(v["4. close"]), high: parseFloat(v["2. high"]), low: parseFloat(v["3. low"]) }))
    .filter((p) => Number.isFinite(p.close) && Number.isFinite(p.high) && Number.isFinite(p.low));
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// Alpha Vantage reports limits and bad symbols as ordinary 200 responses with a text key.
// The order matters: its "slow down" (1 request per second) reply ALSO mentions the 25/day limit and
// the premium plans, so it must be recognised first or it gets mistaken for the daily limit.
export function classifyError(json) {
  if (json?.["Time Series (Daily)"]) return null;
  const text = String(json?.Information ?? json?.Note ?? json?.["Error Message"] ?? "");
  if (/invalid api call/i.test(text)) return "not_found";
  if (/per second|spread(ing)? out|sparingly|burst/i.test(text)) return "burst";
  if (/premium endpoint|is a premium/i.test(text)) return "premium";
  if (/25 requests per day|rate limit|per day|call frequency/i.test(text)) return "daily_limit";
  return "unavailable";
}

const TRADING_DAYS = { m1: 21, m3: 63 };
const change = (series, n) => (series.length > n ? series.at(-1).close / series.at(-1 - n).close - 1 : null);

export function summarize(series) {
  if (!series || series.length < 2) return null;
  const last = series.at(-1);
  const rets = [];
  for (let i = 1; i < series.length; i++) rets.push(series[i].close / series[i - 1].close - 1);
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(1, rets.length - 1);
  const high = Math.max(...series.map((p) => p.high));
  const low = Math.min(...series.map((p) => p.low));
  return {
    last: last.close,
    asOf: last.date,
    change1m: change(series, TRADING_DAYS.m1),
    change3m: change(series, TRADING_DAYS.m3),
    volatility: Math.sqrt(variance) * Math.sqrt(252), // annualised
    high,
    low,
    rangePos: high > low ? (last.close - low) / (high - low) : null, // 0 = at the low, 1 = at the high
    days: series.length,
  };
}

const CACHE_MAX = 200;
const NEG_TTL_MS = 6 * 3600e3;

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIN_GAP_MS = 1100; // the free key allows about one request per second
const RETRY_WAIT_MS = 1500;

export function createMarketService({ apiKey, fetchFn = fetch, now = () => Date.now(), sleep = realSleep, limit = 25, ttlMs = 12 * 3600e3, store = { load: () => ({}), save: () => {} } }) {
  const state = store.load() || {};
  state.cache ||= {};
  state.budget ||= { day: "", used: 0, keyId: null };
  const inflight = new Map();
  const keyId = fingerprint(apiKey);

  const today = () => new Date(now()).toISOString().slice(0, 10);
  const budget = () => {
    // Reset on a new day, or when the configured key itself has changed — Alpha Vantage's real
    // limit is per key, so a fresh key genuinely has its own untouched 25, and our local counter
    // (which otherwise has no way to know a key was swapped) needs to start over with it.
    if (state.budget.day !== today() || state.budget.keyId !== keyId) state.budget = { day: today(), used: 0, keyId };
    return { used: state.budget.used, limit };
  };
  const fresh = (e) => e && now() - e.at < (e.data ? ttlMs : NEG_TTL_MS);
  const save = () => {
    const keys = Object.keys(state.cache);
    if (keys.length > CACHE_MAX) keys.sort((a, b) => state.cache[a].at - state.cache[b].at).slice(0, keys.length - CACHE_MAX).forEach((k) => delete state.cache[k]);
    try { store.save(state); } catch {}
  };

  // Every call to Alpha Vantage goes through this queue so they are at least MIN_GAP_MS apart,
  // even when several people (or the two sides of one matchup) ask at once.
  let queue = Promise.resolve();
  let lastCallAt = -Infinity;
  const callProvider = (alpha) => {
    const run = queue.then(async () => {
      const wait = lastCallAt + MIN_GAP_MS - now();
      if (wait > 0) await sleep(wait);
      lastCallAt = now();
      try {
        const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(alpha)}&outputsize=compact&apikey=${encodeURIComponent(apiKey)}`;
        return await (await fetchFn(url)).json();
      } catch {
        return null; // network failure
      }
    });
    queue = run.catch(() => {});
    return run;
  };

  async function fetchOne(alpha) {
    state.budget.used++; // count the attempt up front: a failed call still spends a lookup
    save();
    for (let attempt = 0; attempt < 2; attempt++) {
      const json = await callProvider(alpha);
      if (json === null) return { ok: false, error: "unavailable" };
      const err = classifyError(json);
      // TEMPORARY diagnostic: remember the provider's own words for the last error, with the
      // configured key stripped out first (Alpha Vantage's real daily-limit message echoes it back
      // as plain text — that bit it us once already). Remove once classifyError is confirmed
      // correct against a genuinely fresh key's real response.
      if (err) {
        const raw = String(json?.Information ?? json?.Note ?? json?.["Error Message"] ?? "(no text field)");
        state.lastError = { classifiedAs: err, raw: apiKey ? raw.split(apiKey).join("[REDACTED]") : raw, at: now() };
        save();
      }
      if (err === "burst") {
        if (attempt === 0) { await sleep(RETRY_WAIT_MS); continue; } // we were too quick: wait and retry once
        state.budget.used = Math.max(0, state.budget.used - 1); // it never returned data, so give the lookup back
        save();
        return { ok: false, error: "busy" };
      }
      if (err === "daily_limit") { state.budget.used = limit; save(); return { ok: false, error: err }; }
      if (err === "not_found") { state.cache[alpha] = { at: now(), data: null, error: err }; save(); return { ok: false, error: err }; }
      if (err === "premium") return { ok: false, error: err }; // a paid-plan symbol: says nothing about our daily budget
      const stats = err ? null : summarize(parseDaily(json));
      if (!stats) return { ok: false, error: "unavailable" };
      const data = { symbol: alpha, currency: currencyOf(alpha), ...stats };
      state.cache[alpha] = { at: now(), data };
      save();
      return { ok: true, data };
    }
    return { ok: false, error: "busy" };
  }

  // opts.peek: only answer from the cache, never spend a lookup.
  async function get(symbol, { cad = false, peek = false } = {}) {
    if (!apiKey) return { ok: false, error: "no_key", budget: budget() };
    const alpha = toAlpha(symbol, cad);
    if (!alpha) return { ok: false, error: "bad_symbol", budget: budget() };
    const hit = state.cache[alpha];
    if (fresh(hit)) return hit.data ? { ok: true, data: hit.data, cached: true, budget: budget() } : { ok: false, error: hit.error, budget: budget() };
    if (peek) return { ok: false, error: "not_cached", budget: budget() };
    if (budget().used >= limit) {
      // Out of lookups: an old cached answer still beats nothing.
      return hit?.data ? { ok: true, data: hit.data, cached: true, stale: true, budget: budget() } : { ok: false, error: "daily_limit", budget: budget() };
    }
    if (!inflight.has(alpha)) inflight.set(alpha, fetchOne(alpha).finally(() => inflight.delete(alpha)));
    const r = await inflight.get(alpha);
    return { ...r, cached: false, budget: budget() };
  }

  // TEMPORARY diagnostic: force the counter back to 0 for the currently configured key, so a fix
  // can be tested against a real fresh call without waiting on a day change or another key swap.
  // Remove alongside lastError once classifyError is confirmed correct.
  function resetBudget() {
    state.budget = { day: today(), used: 0, keyId };
    save();
  }
  return { get, resetBudget, status: () => ({ enabled: !!apiKey, budget: budget(), lastError: state.lastError || null }) };
}
