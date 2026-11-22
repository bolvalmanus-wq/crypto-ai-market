# Cloud scheduler setup

This is a separate Cloudflare Worker. It runs on Cloudflare Cron every 30 minutes (UTC), independent of the phone/browser.

## Required one-time Cloudflare setup
1. Create a Workers KV namespace named `crypto-ai-analysis`.
2. Copy its namespace ID into `scheduler/wrangler.toml`, replacing `REPLACE_WITH_CLOUDFLARE_KV_NAMESPACE_ID`.
3. Deploy this folder as a Worker named `crypto-ai-scheduler` (entry point `worker.js`, config `wrangler.toml`) and enable the Cron trigger shown in the config.
4. In the Worker Settings > Variables and Secrets, add secret `GEMINI_API_KEY` (paste the new key directly in Cloudflare; never in GitHub or chat). Optional vars: `GEMINI_MODEL`, `GEMINI_FALLBACK_MODEL`.
5. Verify `https://crypto-ai-scheduler.<your-subdomain>.workers.dev/health` returns `{"ok":true,...}`.

The scheduled job requests the existing Pages market endpoint for BTC and SOL, analyzes confirmed 30m and 1h candles with Gemini, and stores latest results plus up to 90 days of history in KV. It does not place trades.

## Important
- Cloudflare Pages and this Worker are separate deployments. A green Pages deployment alone does not activate this Cron Worker.
- The existing Pages project's `GEMINI_API_KEY` secret is not automatically shared with this Worker. Add it separately in Worker secrets.
- The Worker currently exposes `/latest` and `/history` endpoints. The app UI needs to be connected to this Worker URL after the Worker is deployed.
- Cron runs at UTC half-hour boundaries. Cloudflare may delay scheduled execution slightly.
