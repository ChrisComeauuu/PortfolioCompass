# Portfolio Compass

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
deposits/withdrawals from SnapTrade account activity. Enter the year you turned 18, FHSA open year, or your
CRA-confirmed room with an "as of" date for better accuracy. Deposits that are really transfers between your own
accounts can be excluded in the UI. Contributions made at other institutions aren't visible.
Settings persist to `data/room-settings.json` (set `SETTINGS_FILE` to change); on Render's free tier this resets on redeploy.
Run tests with `node --test`.

## Head to head (stock matchups)
The Head to head card compares two stocks row by row and highlights who leads each row.
- **Your holdings** work with no setup: position value, share of portfolio, share held in registered accounts, gain/loss, type and listing.
- **Market rows** (latest close, 1- and 3-month change, volatility, position in the ~100-day range) and **outside tickers** need a free [Alpha Vantage](https://www.alphavantage.co/) key. Put it in `.env` as `ALPHAVANTAGE_KEY` (and in Render's environment variables). Without it the market controls are simply hidden.
- The free key allows about 25 lookups a day (`AV_DAILY_LIMIT` to change). The app protects that budget: nothing is fetched until you press "Load market data", results are cached for 12 hours (saved to `data/market-cache.json`), cached results are free, and lookups require sign-in. Canadian tickers are translated for Alpha Vantage (`XEQT.TO` becomes `XEQT.TRT`).
- Free history is about 100 trading days, so there is no 1-year return. Fundamentals such as P/E and dividend yield are not included yet.
- Logic lives in `public/head-to-head.js` (comparison) and `market-data.js` (data service); tests: `node --test`.
