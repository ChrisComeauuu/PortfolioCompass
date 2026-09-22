// Estimates of registered-account contribution room. These are NOT CRA figures.

export const TFSA_LIMITS = {
  2009: 5000, 2010: 5000, 2011: 5000, 2012: 5000, 2013: 5500, 2014: 5500, 2015: 10000,
  2016: 5500, 2017: 5500, 2018: 5500, 2019: 6000, 2020: 6000, 2021: 6000, 2022: 6000,
  2023: 6500, 2024: 7000, 2025: 7000, 2026: 7000,
};
export const FHSA_ANNUAL = 8000;
export const FHSA_LIFETIME = 40000;
export const RRSP_BUFFER = 2000; // lifetime over-contribution buffer before penalty

const yearOf = (d) => new Date(d).getUTCFullYear();
const sum = (xs) => xs.reduce((s, x) => s + x.amount, 0);
const tfsaLimit = (y) => TFSA_LIMITS[y] ?? TFSA_LIMITS[Math.max(...Object.keys(TFSA_LIMITS).map(Number))];

// TFSA room starts accruing in the calendar year you turn 18.
export const turned18 = (settings) => (settings.birthYear ? settings.birthYear + 18 : settings.turned18Year || null);

// contributions/withdrawals: [{ date, amount }] with positive amounts.
export function tfsaRoom({ contributions, withdrawals, settings = {}, now = new Date() }) {
  const year = now.getUTCFullYear();
  const c = settings.confirmedRoom;
  let room, counted;
  if (c?.asOf && c.amount != null) {
    const asOf = new Date(c.asOf);
    const asOfYear = asOf.getUTCFullYear();
    let limits = 0;
    for (let y = asOfYear + 1; y <= year; y++) limits += tfsaLimit(y);
    counted = sum(contributions.filter((x) => new Date(x.date) > asOf));
    room = c.amount + limits - counted + sum(withdrawals.filter((x) => new Date(x.date) > asOf && yearOf(x.date) < year));
  } else if (turned18(settings)) {
    const start = Math.max(2009, turned18(settings));
    let limits = 0;
    for (let y = start; y <= year; y++) limits += tfsaLimit(y);
    counted = sum(contributions);
    room = limits - counted + sum(withdrawals.filter((x) => yearOf(x.date) < year));
  } else return { needsSetup: true };
  return {
    room,
    totalRoom: room + counted, // room before any contributions were made
    limitThisYear: tfsaLimit(year),
    contributedThisYear: sum(contributions.filter((x) => yearOf(x.date) === year)),
    over: room < 0,
  };
}

export function fhsaRoom({ contributions, settings = {}, now = new Date() }) {
  const year = now.getUTCFullYear();
  if (!settings.fhsaOpenYear) return { needsSetup: true };
  let carry = 0;
  let available = 0;
  for (let y = settings.fhsaOpenYear; y <= year; y++) {
    available = FHSA_ANNUAL + Math.min(carry, FHSA_ANNUAL);
    if (y < year) {
      const used = sum(contributions.filter((x) => yearOf(x.date) === y));
      carry = Math.max(0, available - used);
    }
  }
  const thisYear = sum(contributions.filter((x) => yearOf(x.date) === year));
  const lifetimeLeft = FHSA_LIFETIME - sum(contributions);
  const room = Math.min(available - thisYear, lifetimeLeft);
  return { room, totalRoom: room + sum(contributions), limitThisYear: available, contributedThisYear: thisYear, lifetimeLeft, over: room < 0 };
}

export function rrspRoom({ contributions, settings = {}, now = new Date() }) {
  const year = now.getUTCFullYear();
  const c = settings.rrspLimit;
  if (!c?.asOf || c.amount == null) return { needsSetup: true };
  const asOf = new Date(c.asOf);
  const room = c.amount - sum(contributions.filter((x) => new Date(x.date) > asOf));
  return {
    room,
    totalRoom: c.amount,
    limitThisYear: c.amount,
    contributedThisYear: sum(contributions.filter((x) => yearOf(x.date) === year)),
    over: room < -RRSP_BUFFER, // small overage is covered by the $2,000 buffer
    withinBuffer: room < 0 && room >= -RRSP_BUFFER,
  };
}

export function computeRoom(type, args) {
  if (type === "TFSA") return tfsaRoom(args);
  if (type === "FHSA") return fhsaRoom(args);
  if (type === "RRSP") return rrspRoom(args);
  return null;
}

export function classifyAccount(a) {
  const text = [a.raw_type, a.meta?.type, a.meta?.raw_type, a.name].filter(Boolean).join(" ").toUpperCase();
  if (/FHSA|FIRST HOME/.test(text)) return "FHSA";
  if (/TFSA|TAX[- ]?FREE/.test(text)) return "TFSA";
  if (/\bRRSP\b|\bRSP\b|REGISTERED RETIREMENT SAVINGS/.test(text)) return "RRSP";
  return "other";
}
