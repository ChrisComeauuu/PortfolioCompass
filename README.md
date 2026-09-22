# Portfolio Compass

## Why I built this
I trade through Wealthsimple, and while its app is fine for placing trades, it doesn't answer the
questions I actually have: how much room do I have left in my TFSA and FHSA this year, how
concentrated is my portfolio once you count every account together, and how do two of my holdings
actually compare. Wealthsimple shows individual accounts in isolation and has no contribution-room
tracker at all, so I was doing that math by hand.

SnapTrade's OAuth product looked like a good fit and a good way to learn OAuth/OIDC properly:
sign in once with the SnapTrade account I already use, and read (never trade) across every
connected account from one place. So I built Portfolio Compass: a small read-only app that
aggregates holdings across accounts, estimates TFSA/FHSA/RRSP room from public CRA limits plus my
own deposit and withdrawal activity (since SnapTrade has no CRA data), and adds a "head to head"
view for comparing two stocks. It's also the project I used to learn the OAuth authorization-code +
PKCE flow end to end rather than just reading about it.

## What it is
Read-only SnapTrade OAuth app (authorization code + PKCE). Sign in with SnapTrade, then see
holdings across brokerages, allocation, P&L, and concentration insights.

- Backend: `server.js` (Express). Client secret, tokens and PKCE state stay server-side; the browser only holds an HttpOnly session cookie.
- Frontend: `public/index.html` (static, no build).
- Scopes: `openid email read` (no trading).

## Run locally
1. Register a test OAuth app in the SnapTrade dashboard with redirect URI `http://localhost:3000/auth/callback`.
2. `cp .env.example .env`, fill in values, then:
   `set -a; source .env; set +a; npm start`
3. Open http://localhost:3000

## Deploy (Render, free)
1. Push this folder to GitHub, create a Render Web Service (or use `render.yaml`).
2. Set env vars `SNAPTRADE_CLIENT_ID`, `SNAPTRADE_CLIENT_SECRET`, and `REDIRECT_URI=https://<your-service>.onrender.com/auth/callback`.
3. Add that same URL as a redirect URI in the SnapTrade dashboard.
Note: free instances sleep and sessions are in-memory, so users may need to sign in again after idle.

## Contribution room (TFSA / FHSA / RRSP)
SnapTrade has no CRA room data, so the app shows an **estimate**: federal annual limits (`contribution-room.js`) plus
deposits/withdrawals from SnapTrade account activity. Enter your current age, FHSA open year (suggested
automatically from the account's activity when available), or your CRA-confirmed room with an "as of" date for
better accuracy. Transfers between your own accounts can be misread as new contributions, and contributions made
at other institutions aren't visible at all, so treat the number as a starting point and confirm it in CRA My
Account before relying on it.
Settings persist to `data/room-settings.json` (set `SETTINGS_FILE` to change); on Render's free tier this resets on redeploy.
Run tests with `node --test`.

## Head to head (stock matchups)
The Head to head card compares two stocks row by row and highlights who leads each row.
- **Your holdings** work with no setup: position value, share of portfolio, share held in registered accounts, gain/loss, type and listing.
- **Market rows** (latest close, 1- and 3-month change, volatility, position in the ~100-day range) and **outside tickers** need a free [Alpha Vantage](https://www.alphavantage.co/) key. Put it in `.env` as `ALPHAVANTAGE_KEY` (and in Render's environment variables). Without it the market controls are simply hidden.
- The free key allows about 25 lookups a day (`AV_DAILY_LIMIT` to change). The app protects that budget: nothing is fetched until you press "Load market data", results are cached for 12 hours (saved to `data/market-cache.json`), cached results are free, and lookups require sign-in. Canadian tickers are translated for Alpha Vantage (`XEQT.TO` becomes `XEQT.TRT`).
- Free history is about 100 trading days, so there is no 1-year return. Fundamentals such as P/E and dividend yield are not included yet.
- Logic lives in `public/head-to-head.js` (comparison) and `market-data.js` (data service); tests: `node --test`.
