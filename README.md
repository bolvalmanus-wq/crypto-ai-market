# Crypto AI Market

BTC/SOL perpetual-market analysis application.

## Canonical runtime

- Cloudflare Pages serves `index.html`, `performance.html`, and `functions/api/*`.
- The single canonical Cloudflare Worker is configured by the repository-root `wrangler.toml` and runs `worker.js`.
- `worker.js` owns minute scheduling, market analysis, decision ledgers, V2 paper evaluation, performance reports, and Web Push delivery.
- Pages API proxies use `MARKET_WORKER_URL` when explicitly configured; otherwise they use the canonical Worker URL:
  `https://crypto-ai-market-worker.bolvalmanus-wq.workers.dev`.
- The obsolete duplicate scheduler Worker and unused public Gemini API route have been removed to prevent split-brain routing and unintended API-key exposure.

## Required Cloudflare configuration

1. Deploy the repository root as Worker `crypto-ai-market-worker`.
2. Bind KV namespace `ANALYSIS_KV` using the ID in root `wrangler.toml`.
3. Set `VAPID_PRIVATE_KEY` as a Worker secret. The public key is in `wrangler.toml`.
4. In Cloudflare Pages, set `MARKET_WORKER_URL` only if the canonical Worker uses a different URL. Otherwise no scheduler URL is needed.
5. Pages and Worker deployments are separate. A GitHub commit does not automatically prove either deployment succeeded.

## Operating modes and validation

- Legacy indicator decisions and LONG/SHORT notifications remain separate from V2.
- V2 is testing/paper-only. It never places orders.
- Backtest reports are explicitly `NOT_VALIDATED`; single-timeframe results are not equivalent to live multi-timeframe decisions.
- Do not treat an accuracy number as validated until live-equivalent walk-forward tests and at least 100 independently evaluated paper trades are complete.
- No paid data provider or paid trading service is required by this repository.
