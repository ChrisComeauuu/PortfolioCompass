import test from "node:test";
import assert from "node:assert/strict";
import { tfsaRoom, fhsaRoom, rrspRoom, classifyAccount, turned18 } from "./contribution-room.js";

const now = new Date("2026-06-15T00:00:00Z");
const c = (date, amount) => ({ date, amount });

test("TFSA: turned 18 in 2020, nothing contributed => 2020-2026 sum", () => {
  const r = tfsaRoom({ contributions: [], withdrawals: [], settings: { turned18Year: 2020 }, now });
  assert.equal(r.room, 6000 * 3 + 6500 + 7000 * 3); // 45,500
});
test("TFSA: pre-2009 eligibility starts at 2009 ($102,000 by 2026 incl. 2026)", () => {
  const r = tfsaRoom({ contributions: [], withdrawals: [], settings: { turned18Year: 1990 }, now });
  assert.equal(r.room, 5000 * 4 + 5500 * 2 + 10000 + 5500 * 3 + 6000 * 4 + 6500 + 7000 * 3);
});
test("TFSA: prior-year withdrawal is re-added, current-year is not", () => {
  const base = { contributions: [c("2025-03-01", 7000)], settings: { turned18Year: 2025 }, now };
  const a = tfsaRoom({ ...base, withdrawals: [c("2025-09-01", 3000)] });
  assert.equal(a.room, 14000 - 7000 + 3000);
  const b = tfsaRoom({ ...base, withdrawals: [c("2026-02-01", 3000)] });
  assert.equal(b.room, 14000 - 7000);
});
test("TFSA: CRA-confirmed baseline", () => {
  const r = tfsaRoom({
    contributions: [c("2026-01-10", 2000), c("2025-01-10", 999)],
    withdrawals: [],
    settings: { confirmedRoom: { amount: 10000, asOf: "2025-12-31" } },
    now,
  });
  assert.equal(r.room, 10000 + 7000 - 2000);
  assert.equal(r.contributedThisYear, 2000);
});
test("TFSA: needs setup without inputs; flags over-contribution", () => {
  assert.equal(tfsaRoom({ contributions: [], withdrawals: [], now }).needsSetup, true);
  assert.equal(tfsaRoom({ contributions: [c("2026-01-01", 50000)], withdrawals: [], settings: { turned18Year: 2026 }, now }).over, true);
});
test("FHSA: carry-forward is capped at 8,000 and lifetime at 40,000", () => {
  const r = fhsaRoom({ contributions: [], settings: { fhsaOpenYear: 2024 }, now });
  assert.equal(r.limitThisYear, 16000); // 2024/2025 unused: carry capped at 8k
  const s = fhsaRoom({ contributions: [c("2024-05-01", 8000), c("2025-05-01", 8000)], settings: { fhsaOpenYear: 2024 }, now });
  assert.equal(s.room, 8000);
  assert.equal(s.lifetimeLeft, 24000);
});
test("RRSP: buffer and setup", () => {
  assert.equal(rrspRoom({ contributions: [], now }).needsSetup, true);
  const r = rrspRoom({ contributions: [c("2026-03-01", 11000)], settings: { rrspLimit: { amount: 10000, asOf: "2026-01-01" } }, now });
  assert.equal(r.room, -1000);
  assert.equal(r.over, false);
  assert.equal(r.withinBuffer, true);
});
test("classifyAccount", () => {
  assert.equal(classifyAccount({ raw_type: "Tax-Free Savings Account" }), "TFSA");
  assert.equal(classifyAccount({ name: "My FHSA" }), "FHSA");
  assert.equal(classifyAccount({ meta: { type: "RRSP" } }), "RRSP");
  assert.equal(classifyAccount({ name: "Margin" }), "other");
});

test("TFSA: birth year derives the year turned 18", () => {
  assert.equal(turned18({ birthYear: 2002 }), 2020);
  const r = tfsaRoom({ contributions: [], withdrawals: [], settings: { birthYear: 2002 }, now });
  assert.equal(r.room, 45500);
});

test("totalRoom is room before contributions", () => {
  const t = tfsaRoom({ contributions: [c("2026-03-01", 6600)], withdrawals: [], settings: { turned18Year: 2026 }, now });
  assert.equal(t.room, 400); assert.equal(t.totalRoom, 7000);
  const f = fhsaRoom({ contributions: [c("2025-05-01", 8000)], settings: { fhsaOpenYear: 2024 }, now });
  assert.equal(f.totalRoom, f.room + 8000);
  const r = rrspRoom({ contributions: [c("2026-03-01", 1000)], settings: { rrspLimit: { amount: 10000, asOf: "2026-01-01" } }, now });
  assert.equal(r.totalRoom, 10000);
});
