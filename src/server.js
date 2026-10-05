// clinic-automation — process entry (src/server.js)
// Purpose: boot db (migrate-on-boot), start cron jobs (M5 hook, optional),
// listen on PORT. Run: `node src/server.js` (npm start).
'use strict';

const { getConfig } = require('./config');

function main() {
  const cfg = getConfig();
  // Migrate DB on boot.
  require('./db/db').getDb();
  // Start scheduled jobs if they have landed (M5); never crash without them.
  // jobs/index.js exposes startAll (preferred) — older shape start also tried.
  try {
    const jobs = require('./jobs');
    const start = jobs && (jobs.startAll || jobs.start);
    if (typeof start === 'function') {
      const tasks = start.call(jobs);
      console.log(`[server] cron jobs started (${Array.isArray(tasks) ? tasks.length : '?'} schedules)`);
    }
  } catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND') throw e;
    console.log('[server] jobs module not present yet — running without cron');
  }
  const { createApp } = require('./app');
  const app = createApp();
  app.listen(cfg.port, () => console.log(`[server] ${cfg.clinicName} listening on :${cfg.port}`));
}

if (require.main === module) main();
module.exports = { main };
