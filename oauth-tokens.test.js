import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from "jose";
import { verifyIdToken, refreshOnce, ISSUER } from "./oauth-tokens.js";

const CLIENT = "client-123";
const NONCE = "nonce-abc";

const rsa = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(rsa.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
const keys = createLocalJWKSet({ keys: [jwk] });

// Sign a token with sensible defaults; each test overrides one thing.
async function token({ key = rsa.privateKey, alg = "RS256", kid = "k1", iss = ISSUER, aud = CLIENT, nonce = NONCE, sub = "user-1", iat, exp = "5m" } = {}) {
  const jwt = new SignJWT({ nonce, email: "a@b.c" }).setProtectedHeader({ alg, kid }).setIssuer(iss).setAudience(aud).setExpirationTime(exp);
  if (sub) jwt.setSubject(sub);
  if (iat !== undefined) jwt.setIssuedAt(iat); else jwt.setIssuedAt();
  return jwt.sign(key);
}
const ok = (t, o = {}) => verifyIdToken(t, keys, { clientId: CLIENT, nonce: NONCE, ...o });

test("a valid token verifies and returns the claims", async () => {
  const p = await ok(await token());
  assert.equal(p.sub, "user-1");
  assert.equal(p.email, "a@b.c");
});

test("wrong nonce, audience and issuer are rejected", async () => {
  await assert.rejects(ok(await token({ nonce: "someone-elses" })), /nonce/);
  await assert.rejects(ok(await token({ aud: "other-app" })));
  await assert.rejects(ok(await token({ iss: "https://evil.example" })));
});

test("an expired token is rejected", async () => {
  const past = Math.floor(Date.now() / 1000) - 3600;
  await assert.rejects(ok(await token({ iat: past - 60, exp: past })));
});

test("a token issued too long ago is rejected even if it hasn't expired", async () => {
  const stale = Math.floor(Date.now() / 1000) - 3 * 3600;
  await assert.rejects(ok(await token({ iat: stale, exp: "2h" })), /"iat"|too old|maxTokenAge/i);
});

test("a token with no issue time is rejected", async () => {
  const jwt = new SignJWT({ nonce: NONCE }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(ISSUER).setAudience(CLIENT).setSubject("u").setExpirationTime("5m");
  await assert.rejects(ok(await jwt.sign(rsa.privateKey)));
});

test("only RS256 is accepted, and a forged signature is rejected", async () => {
  const other = await generateKeyPair("RS256"); // right algorithm, wrong key
  await assert.rejects(ok(await token({ key: other.privateKey })));
  const ps = await generateKeyPair("PS256");     // a different algorithm the key set doesn't hold
  await assert.rejects(ok(await token({ key: ps.privateKey, alg: "PS256" })));
  // "alg: none" style tampering: an unsigned token must never verify
  const unsigned = [Buffer.from('{"alg":"none"}').toString("base64url"), Buffer.from(JSON.stringify({ iss: ISSUER, aud: CLIENT, sub: "x", nonce: NONCE, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300 })).toString("base64url"), ""].join(".");
  await assert.rejects(ok(unsigned));
});

test("an unknown key id is rejected", async () => {
  await assert.rejects(ok(await token({ kid: "not-in-the-key-set" })));
});

test("a token with no subject is rejected", async () => {
  await assert.rejects(ok(await token({ sub: null })), /subject/);
});

// ---- refresh ----
const session = () => ({ tokens: { access_token: "a0", refresh_token: "r0", id_token: "idt" }, expiresAt: 0 });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test("simultaneous refreshes share one request (the rotation race)", async () => {
  const s = session(); let calls = 0;
  const tokenRequest = async ({ refresh_token }) => {
    calls++;
    await delay(20);
    if (refresh_token !== "r0") throw new Error("refresh token already used"); // what SnapTrade would do
    return { access_token: "a1", refresh_token: "r1", expires_in: 36000 };
  };
  await Promise.all([refreshOnce(s, tokenRequest), refreshOnce(s, tokenRequest), refreshOnce(s, tokenRequest)]);
  assert.equal(calls, 1);
  assert.deepEqual([s.tokens.access_token, s.tokens.refresh_token], ["a1", "r1"]);
  assert.equal(s.tokens.id_token, "idt"); // refresh responses carry no id_token, so the original is kept
});

test("refresh stores the new expiry, and a later refresh uses the rotated token", async () => {
  const s = session(); const seen = [];
  const tokenRequest = async ({ refresh_token }) => { seen.push(refresh_token); return { access_token: "n" + seen.length, refresh_token: "r" + seen.length, expires_in: 100 }; };
  await refreshOnce(s, tokenRequest, () => 1_000);
  assert.equal(s.expiresAt, 1_000 + 100_000);
  await refreshOnce(s, tokenRequest, () => 2_000);
  assert.deepEqual(seen, ["r0", "r1"]);
});

test("a failed refresh doesn't wedge the session; the next attempt can succeed", async () => {
  const s = session(); let n = 0;
  const tokenRequest = async () => { n++; if (n === 1) throw new Error("network"); return { access_token: "a1", refresh_token: "r1", expires_in: 60 }; };
  await assert.rejects(refreshOnce(s, tokenRequest), /network/);
  assert.equal(s.refreshing, null);
  await refreshOnce(s, tokenRequest);
  assert.equal(s.tokens.access_token, "a1");
});
