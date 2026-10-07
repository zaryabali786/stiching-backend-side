import app from './app.js';
import { config } from './config/env.js';
import { initSocket } from './realtime/socket.js';

const server = app.listen(config.port, () => {
  console.log(`=========================================`);
  console.log(` Server is running on port ${config.port}`);
  console.log(` Environment: ${config.nodeEnv}`);
  console.log(` Health Check: http://localhost:${config.port}/api/health`);
  console.log(` Auth Register: POST http://localhost:${config.port}/api/auth/register`);
  console.log(` Auth Login:    POST http://localhost:${config.port}/api/auth/login`);
  console.log(` Auth Profile:  GET  http://localhost:${config.port}/api/auth/me`);
  console.log(` Realtime:      Socket.IO on http://localhost:${config.port}`);
  console.log(`=========================================`);
});

// Real-time order conversations share the HTTP server (same port, path /socket.io)
initSocket(server);

// Handle graceful shutdown
const shutdown = (signal) => {
  console.log(`Received ${signal}. Shutting down gracefully...`);
  server.close(() => {
    console.log('HTTP server closed.');
    process.exit(0);
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
