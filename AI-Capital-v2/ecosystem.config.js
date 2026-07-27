'use strict';

module.exports = {
  apps: [
    {
      name:         'ai-v2-secretary',
      script:       'index.js',
      cwd:          __dirname,
      autorestart:  true,
      max_restarts: 15,
      min_uptime:   '30s',
      restart_delay: 5000,
    },
    {
      name:         'ai-v2-watchdog',
      script:       'watchdog.js',
      cwd:          __dirname,
      autorestart:  true,
      max_restarts: 15,
      min_uptime:   '10s',
      restart_delay: 5000,
    },
  ],
};
