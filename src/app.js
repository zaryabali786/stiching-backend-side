import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import apiRouter from './routes/index.js';
import { notFoundHandler, errorHandler } from './middlewares/error.middleware.js';
import { stripeWebhook } from './controllers/payment.controller.js';

const app = express();

// Middlewares
app.use(cors({
  origin: '*', // Adjust or restrict in production as needed
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Partner-Id'],
}));

app.use(morgan('dev'));
// Stripe signs the exact bytes it sends: this route needs the RAW body, so it is registered before any JSON parser
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json', limit: '1mb' }), stripeWebhook);

// Postmark inbound emails can be up to ~35 MB with attachments; parsed here so the global limit below stays small
app.use('/api/inbound/email', express.json({ limit: '45mb' }));
// Large enough for a few base64-encoded photos (issue evidence, QC photos)
app.use(express.json({ limit: '30mb' }));
app.use(express.urlencoded({ extended: true, limit: '30mb' }));

// Root welcome endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'Welcome to Stitching as a Service API',
    version: '1.0.0',
    documentation: '/api/health',
  });
});

// API Routes
app.use('/api', apiRouter);

// 404 & Global Error Handlers
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
