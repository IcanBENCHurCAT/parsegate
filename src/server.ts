import { serve } from '@hono/node-server';
import { app } from './index.js';
import { config } from './config.js';
import { jobStore } from './jobs.js';
import { rateLimiter } from './rate-limit.js';

const PORT = config.port;

if (import.meta.url.endsWith(process.argv[1] || '')) {
  const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
    console.log(`Parsegate listening on http://localhost:${info.port}`);
    console.log('Routes:');
    console.log('  GET    /health              — Health check');
    console.log('  GET    /v1/plan             — Discovery (free tier, no auth)');
    console.log('  GET    /v1/pricing          — Price table');
    console.log('  POST   /v1/detect           — Detect file format');
    console.log('  POST   /v1/parse             — Sync parse (x402)');
    console.log('  POST   /v1/parse/async      — Async parse (x402 or free tier)');
    console.log('  GET    /v1/jobs/:id          — Poll job status');
    console.log('  GET    /v1/jobs/stats        — Job queue stats');
  });

  // Cleanup interval to prevent memory leaks in long-running deployments
  // Runs every hour
  const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
  // Jobs older than 24 hours are cleaned up
  const JOB_MAX_AGE_MS = 24 * 60 * 60 * 1000;

  const cleanupTimer = setInterval(() => {
    try {
      const jobsCleaned = jobStore.cleanup(JOB_MAX_AGE_MS);
      const ratesCleaned = rateLimiter.cleanup();
      if (jobsCleaned > 0 || ratesCleaned > 0) {
        console.log(`[Cleanup] Removed ${jobsCleaned} old jobs and ${ratesCleaned} stale rate limits.`);
      }
    } catch (err) {
      console.error('[Cleanup] Error during periodic cleanup:', err);
    }
  }, CLEANUP_INTERVAL_MS);

  // Graceful shutdown
  const shutdown = () => {
    console.log('\nShutting down gracefully...');
    clearInterval(cleanupTimer);

    // Set a timeout to forcefully exit if closing takes too long
    const forceExitTimer = setTimeout(() => {
      console.error('Could not close connections in time, forcefully shutting down');
      process.exit(1);
    }, 10000);

    // Unref the timer so it doesn't block exit
    forceExitTimer.unref();

    server.close(() => {
      console.log('Closed out remaining connections.');
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
