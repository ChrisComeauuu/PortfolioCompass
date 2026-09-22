import { jwtVerify } from "jose";

export const ISSUER = "https://api.snaptrade.com";

// Verify an OIDC id_token: signature (RS256 only, against the key whose kid matches), issuer,
// audience, expiry, that it was issued recently (a token we just received from the code exchange
// should be minutes old at most), and that its nonce is the one we generated for this login.
export async function verifyIdToken(idToken, keys, { clientId, nonce, issuer = ISSUER }) {
  const { payload } = await jwtVerify(idToken, keys, {
    issuer,
    audience: clientId,
    algorithms: ["RS256"], // never accept whatever algorithm the token claims
    maxTokenAge: "10 minutes", // also rejects a token with no iat
    clockTolerance: 60,
  });
  if (payload.nonce !== nonce) throw new Error("ID token nonce mismatch");
  if (!payload.sub) throw new Error("ID token has no subject");
  return payload;
}

// Refresh tokens rotate: using one invalidates it. If two requests find the access token expired
// at the same moment and both refreshed, the second would send an already-used refresh token and
// fail. So every caller shares a single in-flight refresh per session.
export function refreshOnce(session, tokenRequest, now = Date.now) {
  if (!session.refreshing) {
    session.refreshing = (async () => {
      const t = await tokenRequest({ grant_type: "refresh_token", refresh_token: session.tokens.refresh_token });
      session.tokens = { ...session.tokens, ...t }; // replace the rotated refresh token in one assignment
      session.expiresAt = now() + t.expires_in * 1000;
    })().finally(() => { session.refreshing = null; }); // a failure must not wedge later attempts
  }
  return session.refreshing;
}
