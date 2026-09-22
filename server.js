import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRemoteJWKSet } from "jose";
import { verifyIdToken, refreshOnce } from "./oauth-tokens.js";
import { classifyAccount, computeRoom } from "./contribution-room.js";
import { createMarketService } from "./market-data.js";

const {
  SNAPTRADE_CLIENT_ID: CLIENT_ID,
  SNAPTRADE_CLIENT_SECRET: CLIENT_SECRET,
  REDIRECT_URI,
  PORT = 3000,
} = process.env;

if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
  console.error("Missing SNAPTRADE_CLIENT_ID, SNAPTRADE_CLIENT_SECRET or REDIRECT_URI");
  process.exit(1);
}

const API = "https://api.snaptrade.com";
const SCOPE = "openid email read";
const isProd = REDIRECT_URI.startsWith("https://");
const b64url = (buf) => Buffer.from(buf).toString("base64url");
const basicAuth = "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");

// In-memory stores. Fine for a demo; a free Render instance resets on sleep,
// so users simply sign in again. Swap for Redis/Postgres for real use.
const pending = new Map(); // state -> { verifier, nonce, exp }
const sessions = new Map(); // sid -> { tokens, expiresAt, email }

let metadata, jwks;
async function getMetadata() {
  if (!metadata) {
    const r = await fetch(`${API}/.well-known/oauth-authorization-server`);
    if (!r.ok) throw new Error("Could not load OAuth metadata");
    metadata = await r.json();
    jwks = createRemoteJWKSet(new URL(metadata.jwks_uri));
  }
  return metadata;
}

function parseCookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || "").split(";").map((c) => c.trim().split("=")).filter((p) => p[0])
  );
}
function setCookie(res, name, value, maxAge) {
  res.append(
    "Set-Cookie",
    `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isProd ? "; Secure" : ""}`
  );
}
const getSession = (req) => sessions.get(parseCookies(req).sid);

async function tokenRequest(params) {
  const { token_endpoint } = await getMetadata();
  const r = await fetch(token_endpoint, {
    method: "POST",
    headers: { Authorization: basicAuth, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  if (!r.ok) throw new Error(`Token endpoint returned ${r.status}`);
  return r.json();
}

async function accessToken(session) {
  if (Date.now() < session.expiresAt - 60_000) return session.tokens.access_token;
  await refresh(session);
  return session.tokens.access_token;
}
// One shared refresh per session (see oauth-tokens.js): SnapTrade rotates refresh tokens, so two parallel refreshes would fail.
const refresh = (session) => refreshOnce(session, tokenRequest);

async function snap(session, path) {
  const call = async () =>
    fetch(API + path, {
      headers: { Authorization: `Bearer ${await accessToken(session)}`, Accept: "application/json" },
    });
  let r = await call();
  if (r.status === 401) {
    await refresh(session); // refresh once, retry once
    r = await call();
  }
  if (!r.ok) throw Object.assign(new Error(`SnapTrade ${path} -> ${r.status}`), { status: r.status });
  return r.json();
}

// Per-user room settings, persisted to a JSON file keyed by the SnapTrade user id.
// Note: Render's free tier has an ephemeral disk, so this resets on redeploy.
const SETTINGS_FILE = process.env.SETTINGS_FILE || "./data/room-settings.json";
let allSettings = {};
try { allSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")); } catch {}
function saveSettings() {
  try {
    fs.mkdirSync(SETTINGS_FILE.replace(/[^/]*$/, "") || ".", { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(allSettings));
  } catch (e) { console.error("could not save settings:", e.message); }
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "20kb" }));

app.get("/auth/login", async (req, res, next) => {
  try {
    const { authorization_endpoint } = await getMetadata();
    const state = b64url(crypto.randomBytes(32));
    const nonce = b64url(crypto.randomBytes(16));
    const verifier = b64url(crypto.randomBytes(64));
    const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
    pending.set(state, { verifier, nonce, exp: Date.now() + 10 * 60_000 });

    const url = new URL(authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: SCOPE,
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    res.redirect(url.toString());
  } catch (e) { next(e); }
});

app.get("/auth/callback", async (req, res) => {
  const { code, state, error } = req.query;
  const p = pending.get(state);
  pending.delete(state); // single use
  if (error) return res.redirect("/?error=" + encodeURIComponent(error));
  if (!p || p.exp < Date.now() || !code) return res.redirect("/?error=invalid_state");
  try {
    const t = await tokenRequest({
      grant_type: "authorization_code",
      code,
      code_verifier: p.verifier,
      redirect_uri: REDIRECT_URI,
    });
    const payload = await verifyIdToken(t.id_token, jwks, { clientId: CLIENT_ID, nonce: p.nonce });

    const sid = b64url(crypto.randomBytes(32));
    sessions.set(sid, {
      tokens: t,
      expiresAt: Date.now() + t.expires_in * 1000,
      email: payload.email,
      sub: payload.sub,
    });
    setCookie(res, "sid", sid, 36000);
    res.redirect("/");
  } catch (e) {
    console.error("callback failed:", e.message);
    res.redirect("/?error=login_failed");
  }
});

app.post("/auth/logout", async (req, res) => {
  const sid = parseCookies(req).sid;
  const s = sessions.get(sid);
  sessions.delete(sid);
  setCookie(res, "sid", "", 0);
  if (s?.tokens?.refresh_token) {
    try {
      const { revocation_endpoint } = await getMetadata();
      await fetch(revocation_endpoint, {
        method: "POST",
        headers: { Authorization: basicAuth, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: s.tokens.refresh_token, token_type_hint: "refresh_token" }),
      });
    } catch (e) { console.error("revoke failed:", e.message); }
  }
  res.json({ ok: true });
});

app.get("/api/me", (req, res) => {
  const s = getSession(req);
  res.json(s ? { signedIn: true, email: s.email || null } : { signedIn: false });
});

const num = (v) => (typeof v === "number" ? v : Number(v) || 0);

const asList = (r) => (Array.isArray(r) ? r : r?.results || r?.positions || r?.balances || r?.data || []);
const curCode = (c) => (typeof c === "string" ? c : c?.code) || null;

// Handles the current /positions/all shape (instrument + quantity/market_value/average_cost)
// as well as the legacy shape (symbol.symbol + units/price/average_purchase_price).
const amt = (v) => num(typeof v === "object" && v !== null ? v.amount : v);
function normalizePosition(p, fallbackCurrency) {
  const inst = p.instrument;
  const legacy = p.symbol?.symbol ?? p.symbol;
  const symObj = inst || (typeof legacy === "object" ? legacy : null);
  const rawTicker = inst ? inst.symbol : typeof legacy === "object" ? legacy?.symbol : legacy;
  const ticker = typeof rawTicker === "object" ? rawTicker?.symbol : rawTicker;
  const units = num(p.quantity ?? p.units ?? p.fractional_units);
  const price = amt(p.price);
  const value = p.market_value != null ? amt(p.market_value) : units * price;
  const avg = amt(p.average_cost ?? p.average_purchase_price);
  const pnl = p.pnl != null ? amt(p.pnl) : p.open_pnl != null ? amt(p.open_pnl) : avg ? value - units * avg : null;
  return {
    ticker: ticker || "?",
    kind: typeof inst?.kind === "string" ? inst.kind.toLowerCase() : null,
    name: symObj?.description || p.symbol?.description || "",
    units,
    price,
    value,
    costBasis: pnl != null ? value - pnl : 0,
    pnl,
    // Positions without their own currency are assumed to be in the account's currency.
    currency: curCode(p.currency) || curCode(symObj?.currency) || fallbackCurrency,
  };
}

app.get("/api/portfolio", async (req, res) => {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: "not_signed_in" });
  try {
    const seen = new Set();
    const accounts = (await snap(s, "/accounts")).filter((a) => {
      if (["closed", "archived"].includes(String(a.status).toLowerCase())) return false;
      // The same brokerage account connected twice shares an institution_account_id.
      const key = a.institution_account_id && `${a.institution_name}:${a.institution_account_id}`;
      if (key && seen.has(key)) return false;
      if (key) seen.add(key);
      return true;
    });
    const out = await Promise.all(
      accounts.map(async (a) => {
        const currency = curCode(a.balance?.total?.currency) || "CAD";
        const warnings = [];
        const grab = (path, label) =>
          snap(s, path).then(asList).catch((e) => {
            console.error(`${label} failed for account ${a.id}: ${e.message}`);
            warnings.push(`${label} unavailable (${e.status || "error"})`);
            return [];
          });
        const [positions, balances] = await Promise.all([
          grab(`/accounts/${a.id}/positions/all`, "Positions"),
          grab(`/accounts/${a.id}/balances`, "Balances"),
        ]);
        return {
          id: a.id,
          name: a.name || a.institution_name,
          institution: a.institution_name,
          number: a.number ? "…" + String(a.number).slice(-4) : null,
          type: a.raw_type || a.account_category || null,
          status: a.status || null,
          total: a.balance?.total ? num(a.balance.total.amount) : null,
          currency,
          cash: balances.map((b) => ({ currency: curCode(b.currency) || currency, amount: num(b.cash) })),
          positions: positions.map((p) => normalizePosition(p, currency)),
          warnings,
        };
      })
    );
    res.json({ accounts: out });
  } catch (e) {
    console.error(e.message);
    if (e.status === 401) {
      sessions.delete(parseCookies(req).sid);
      return res.status(401).json({ error: "reauthorize" });
    }
    res.status(502).json({ error: "snaptrade_error" });
  }
});

// USD->CAD rate from the ECB via Frankfurter (no key needed), cached for 6 hours.
let fx = { at: 0, data: null };
app.get("/api/fx", async (req, res) => {
  if (!fx.data || Date.now() - fx.at > 6 * 3600_000) {
    try {
      const r = await fetch("https://api.frankfurter.dev/v1/latest?base=USD&symbols=CAD");
      const j = await r.json();
      if (!r.ok || !j.rates?.CAD) throw new Error("bad response");
      fx = { at: Date.now(), data: { usdToCad: j.rates.CAD, date: j.date } };
    } catch (e) {
      console.error("fx failed:", e.message);
      if (!fx.data) return res.status(502).json({ error: "fx_unavailable" });
    }
  }
  res.json(fx.data);
});

// ---- Contribution room (estimates) ----
const isYear = (v) => Number.isInteger(v) && v >= 1900 && v <= new Date().getUTCFullYear() + 1;
const isDate = (v) => typeof v === "string" && !Number.isNaN(Date.parse(v));
const isAmt = (v) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 1e8;

function cleanSettings(b = {}) {
  const out = {};
  if (isYear(b.birthYear)) { out.birthYear = b.birthYear; out.birthdayPassed = b.birthdayPassed !== false; }
  if (isYear(b.turned18Year)) out.turned18Year = b.turned18Year;
  if (isYear(b.fhsaOpenYear)) out.fhsaOpenYear = b.fhsaOpenYear;
  for (const k of ["confirmedRoom", "rrspLimit"])
    if (b[k] && isAmt(b[k].amount) && isDate(b[k].asOf)) out[k] = { amount: b[k].amount, asOf: b[k].asOf.slice(0, 10) };
  return out;
}

app.get("/api/room-settings", (req, res) => {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: "not_signed_in" });
  res.json(allSettings[s.sub] || {});
});
app.delete("/api/room-settings", (req, res) => {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: "not_signed_in" });
  delete allSettings[s.sub];
  saveSettings();
  res.json({ ok: true });
});
app.put("/api/room-settings", (req, res) => {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: "not_signed_in" });
  allSettings[s.sub] = cleanSettings(req.body);
  saveSettings();
  res.json(allSettings[s.sub]);
});

async function fetchActivities(s, accountId) {
  const all = [];
  for (let offset = 0; offset < 10000; offset += 1000) {
    const r = await snap(s, `/accounts/${accountId}/activities?offset=${offset}&limit=1000`);
    const page = Array.isArray(r) ? r : r.data || [];
    all.push(...page);
    if (page.length < 1000) break;
  }
  return all;
}

const CONTRIB = /^(CONTRIBUTION|DEPOSIT)$/i;
const WITHDRAW = /^WITHDRAWAL$/i;
function toFlows(activities, accountId) {
  const contributions = [], withdrawals = [];
  activities.forEach((a, i) => {
    const date = a.trade_date || a.settlement_date;
    const amount = Math.abs(num(a.amount));
    if (!date || !amount) return;
    const flow = {
      id: a.id ? String(a.id) : `${accountId}:${date}:${a.type}:${amount}:${i}`,
      date: String(date).slice(0, 10),
      amount,
      type: String(a.type).toUpperCase(),
      description: a.description || "",
    };
    if (CONTRIB.test(a.type)) contributions.push(flow);
    else if (WITHDRAW.test(a.type)) withdrawals.push(flow);
  });
  return { contributions, withdrawals };
}

// TEMPORARY diagnostic: what does this account's real activity data actually look like?
// Returns only raw type labels + counts and basic shape checks — never an amount, date, or
// description. Remove this route once contribution matching is confirmed against real data.
app.get("/api/debug-activity-types", async (req, res) => {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: "not_signed_in" });
  try {
    const accounts = (await snap(s, "/accounts")).filter((a) => classifyAccount(a) !== "other");
    const out = await Promise.all(
      accounts.map(async (a) => {
        let activities;
        try { activities = await fetchActivities(s, a.id); }
        catch (e) { return { accountType: classifyAccount(a), error: e.status || "error" }; }
        const rawTypes = {};
        let missingDate = 0, missingOrZeroAmount = 0;
        for (const act of activities) {
          const t = String(act.type ?? "(no type field)");
          rawTypes[t] = (rawTypes[t] || 0) + 1;
          if (!(act.trade_date || act.settlement_date)) missingDate++;
          if (!num(act.amount)) missingOrZeroAmount++;
        }
        return { accountType: classifyAccount(a), activityCount: activities.length, rawTypes, missingDate, missingOrZeroAmount };
      })
    );
    res.json({ accounts: out });
  } catch (e) {
    console.error(e.message);
    res.status(502).json({ error: "snaptrade_error" });
  }
});

app.get("/api/room", async (req, res) => {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: "not_signed_in" });
  try {
    const settings = allSettings[s.sub] || {};
    const accounts = (await snap(s, "/accounts")).filter((a) => classifyAccount(a) !== "other");

    // Suggest an FHSA open year: the broker's opening_date if provided, else the first
    // transaction SnapTrade has seen. Your own entry always wins.
    let suggested = null;
    for (const a of accounts.filter((x) => classifyAccount(x) === "FHSA")) {
      const cands = [
        [a.opening_date, "opening date"],
        [a.sync_status?.transactions?.first_transaction_date, "first transaction"],
      ];
      const hit = cands.find(([d]) => d && !Number.isNaN(Date.parse(d)));
      if (!hit) continue;
      const year = new Date(hit[0]).getUTCFullYear();
      if (!suggested || year < suggested.year) suggested = { year, source: hit[1] };
    }
    const effective = { ...settings };
    if (!settings.fhsaOpenYear && suggested) effective.fhsaOpenYear = suggested.year;

    const out = await Promise.all(
      accounts.map(async (a) => {
        const type = classifyAccount(a);
        let flows;
        try { flows = toFlows(await fetchActivities(s, a.id), a.id); }
        catch (e) { if (e.status === 401) throw e; return { id: a.id, name: a.name, type, error: "activities_unavailable" }; }
        const args = { contributions: flows.contributions, withdrawals: flows.withdrawals, settings: effective };
        return {
          id: a.id,
          name: a.name || a.institution_name,
          institution: a.institution_name,
          type,
          ...computeRoom(type, args),
        };
      })
    );
    res.json({ accounts: out, fhsaSuggestion: settings.fhsaOpenYear ? null : suggested });
  } catch (e) {
    console.error(e.message);
    if (e.status === 401) {
      sessions.delete(parseCookies(req).sid);
      return res.status(401).json({ error: "reauthorize" });
    }
    res.status(502).json({ error: "snaptrade_error" });
  }
});

// ---- Market data (optional; needs ALPHAVANTAGE_KEY) ----
const MARKET_FILE = process.env.MARKET_FILE || "./data/market-cache.json";
const market = createMarketService({
  apiKey: process.env.ALPHAVANTAGE_KEY || "",
  limit: Number(process.env.AV_DAILY_LIMIT) || 25,
  store: {
    load: () => { try { return JSON.parse(fs.readFileSync(MARKET_FILE, "utf8")); } catch { return {}; } },
    save: (state) => {
      fs.mkdirSync(MARKET_FILE.replace(/[^/]*$/, "") || ".", { recursive: true });
      fs.writeFileSync(MARKET_FILE, JSON.stringify(state));
    },
  },
});
const MARKET_STATUS = { no_key: 503, bad_symbol: 400, daily_limit: 429, busy: 503, premium: 422, not_found: 404, not_cached: 404, unavailable: 502 };

app.get("/api/market-status", (req, res) => {
  if (!getSession(req)) return res.status(401).json({ error: "not_signed_in" });
  res.json(market.status());
});
app.get("/api/market", async (req, res) => {
  // Sign-in is required so strangers can't use up the shared daily lookups.
  if (!getSession(req)) return res.status(401).json({ error: "not_signed_in" });
  const r = await market.get(String(req.query.symbol || ""), { cad: req.query.cad === "1", peek: req.query.peek === "1" });
  if (!r.ok) {
    if (r.error !== "not_cached") console.error("market lookup failed:", r.error); // codes only, never the URL or key
    return res.status(MARKET_STATUS[r.error] || 502).json({ error: r.error, budget: r.budget });
  }
  res.json({ ...r.data, cached: r.cached, stale: !!r.stale, budget: r.budget });
});

app.use(express.static("public"));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send("Server error");
});

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pending) if (v.exp < now) pending.delete(k);
}, 60_000).unref();

app.listen(PORT, () => console.log(`Portfolio Compass on :${PORT}`));
