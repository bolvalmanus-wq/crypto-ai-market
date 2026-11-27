# Crypto AI Market

BTC/SOL perpetual-market analysis application.

## Canonical runtime

- Cloudflare Pages serves `index.html` and `functions/api/*`.
- The single canonical Cloudflare Worker is configured by the repository-root `wrangler.toml` and runs `worker.js`.
- `worker.js` owns scheduled 30m/1h/4h market analysis, decision evaluation, and Web Push delivery.
- Pages API proxies use `MARKET_WORKER_URL` when explicitly configured; otherwise they use the canonical Worker URL:
  `https://crypto-ai-market-worker.bolvalmanus.workers.dev`.
- The obsolete duplicate scheduler Worker and unused public Gemini API route have been removed to prevent split-brain routing and unintended API-key exposure.

## Required Cloudflare configuration

1. Deploy the repository root as Worker `crypto-ai-market-worker`.
2. Bind KV namespace `ANALYSIS_KV` using the ID in root `wrangler.toml`.
3. Set `VAPID_PRIVATE_KEY` as a Worker secret. The public key is in `wrangler.toml`.
4. In Cloudflare Pages, set `MARKET_WORKER_URL` only if the canonical Worker uses a different URL. Otherwise no scheduler URL is needed.
5. Pages and Worker deployments are separate. A GitHub commit does not automatically prove either deployment succeeded.

## Operating modes and validation

- Legacy analysis is currently indicator-only; AI model calls are disabled. Existing LONG/SHORT notifications remain separate from V2.
- V2 is a rule-based research engine in testing/paper-only mode. It never places orders.
- Only 30m, 1h, and 4h are supported analysis timeframes.
- Do not treat an accuracy number as validated until live-equivalent walk-forward tests and at least 100 independently evaluated paper trades are complete.
- No paid data provider or paid trading service is required by this repository.

## Automated quality gates

- Every push to `main` and pull request targeting `main` runs the repository-wide JavaScript/inline-script syntax and configuration checks.
- Node's built-in test runner covers market-provider validation, V2 closed-candle/timeframe safety and Worker push/origin validation.
- V2 candle history is truncated to the latest uninterrupted segment; gaps cannot silently contaminate rolling indicators.
- Live price polling is limited to one refresh every five seconds per open app session.
- Run locally with Node.js 22+: `npm run check` and `npm test`.

These automated checks do not replace Cloudflare deployment verification, live provider monitoring, exchange execution simulation, or independent trading-performance validation.
