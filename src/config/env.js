import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: process.env.PORT || 5000,
  nodeEnv: process.env.NODE_ENV || 'development',
  supabase: {
    url: process.env.SUPABASE_URL,
    publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY,
    secretKey: process.env.SUPABASE_SECRET_KEY,
    jwksUrl: process.env.SUPABASE_JWKS_URL,
  },
  redis: {
    url: process.env.REDIS_URL || '',
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    enabled: process.env.REDIS_ENABLED !== 'false',
    defaultTtl: parseInt(process.env.REDIS_DEFAULT_TTL || '300', 10), // 5 mins in seconds
  },
  // Public platform settings (shown to customers; safe to expose)
  platform: {
    name: process.env.PLATFORM_NAME || 'V360',
    shipToName: process.env.SHIP_TO_NAME || '[Ship-to name]',
    shipToAddress: process.env.SHIP_TO_ADDRESS || '[Ship-to address]',
    shipToCity: process.env.SHIP_TO_CITY || 'Lahore',
    shipToPhone: process.env.SHIP_TO_PHONE || '[Ship-to phone]',
    partnerName: process.env.PARTNER_NAME || 'Ishaal Stitching',
  },
  // Reading brand invoices / forwarded emails (optional — without a key customers fill details in by hand)
  ai: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.AI_MODEL || 'claude-opus-5-5',
    // Only needed when the API key is not scoped to a single workspace (Anthropic Console -> Workspaces -> ID)
    workspaceId: process.env.ANTHROPIC_WORKSPACE_ID || '',
  },
  // Card payments (Stripe). The secret key stays on the server; only the publishable key reaches the apps.
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
  },
  // Google sign-in (authorization-code flow). The secret never leaves the server.
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  },
  // Forwarded brand emails: customers forward to  <local>+<token>@<domain>  built from this address.
  // Your inbound-mail provider posts each email to  POST /api/inbound/email  with INBOUND_EMAIL_SECRET.
  inboundEmail: {
    address: process.env.INBOUND_EMAIL_ADDRESS || '',
    secret: process.env.INBOUND_EMAIL_SECRET || '',
  },
  urls: {
    clientApp: process.env.CLIENT_APP_URL || 'http://localhost:4201',
    adminApp: process.env.ADMIN_APP_URL || 'http://localhost:4200',
  },
};

// Validate critical environment variables
const requiredEnvVars = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY'];
const missingVars = requiredEnvVars.filter((v) => !process.env[v]);

if (missingVars.length > 0) {
  console.warn(`[Config Warning]: Missing required environment variables: ${missingVars.join(', ')}`);
}
