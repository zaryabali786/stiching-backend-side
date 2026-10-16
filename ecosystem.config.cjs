// PM2 process file. Start / reload with:  pm2 startOrReload ecosystem.config.cjs --env production
module.exports = {
  apps: [
    {
      name: 'stitching-backend',
      script: 'src/server.js',
      cwd: __dirname,
      // one instance on purpose: the live chat (Socket.IO) keeps its rooms in memory
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '600M',
      kill_timeout: 8000,
      time: true,
      env: { NODE_ENV: 'development' },
      env_production: { NODE_ENV: 'production' },
    },
  ],
};
