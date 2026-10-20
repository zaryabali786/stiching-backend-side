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
    // 'anthropic' (Claude) or 'openai' (GPT). Unset: Claude when its key is set, otherwise GPT.
    provider: (process.env.AI_PROVIDER || '').trim().toLowerCase(),
    openaiKey: (process.env.OPENAI_API_KEY || '').trim(),
    openaiModel: (process.env.OPENAI_MODEL || 'gpt-4o-mini').trim(),
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
  // PostEx (Pakistan) merchant API. Without a token PostEx works like any other courier: the CN is typed in. The token stays on the server.
  postex: {
    token: process.env.POSTEX_API_TOKEN || '',
    baseUrl: process.env.POSTEX_BASE_URL || 'https://api.postex.pk',
    // the address codes of your PostEx account (Merchant addresses); needed when the account has more than one pickup address
    pickupAddressCode: process.env.POSTEX_PICKUP_ADDRESS_CODE || '',
    storeAddressCode: process.env.POSTEX_STORE_ADDRESS_CODE || '',
    orderType: process.env.POSTEX_ORDER_TYPE || 'Normal',
    timeoutMs: Number(process.env.POSTEX_TIMEOUT_MS) || 15000,
    // how often parcels dispatched with PostEx are checked for tracking updates (minutes); 0 switches the polling off
    pollMinutes: process.env.POSTEX_POLL_MINUTES === undefined ? 15 : Number(process.env.POSTEX_POLL_MINUTES) || 0,
  },
  // The courier's tracking webhook (POST /api/webhooks/courier) is accepted only with this secret in the x-webhook-secret header.
  courier: { webhookSecret: process.env.COURIER_WEBHOOK_SECRET || '' },
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    // optional: the iOS OAuth client of the phone app (native Google sign-in on iPhone); its id_tokens are accepted as well
    // one iOS OAuth client per iPhone app; comma-separated when the client app and the admin app each have their own
    iosClientIds: (process.env.GOOGLE_IOS_CLIENT_ID || '').split(',').map((s) => s.trim()).filter(Boolean),
    iosClientId: (process.env.GOOGLE_IOS_CLIENT_ID || '').split(',')[0].trim(),
  },
  // Sign in with Apple (native, iPhone apps): the bundle id of each app is the audience of Apple's identity token
  apple: {
    clientIds: (process.env.APPLE_CLIENT_IDS || 'com.stitchnship.app,com.stitchnship.admin').split(',').map((s) => s.trim()).filter(Boolean),
  },
  // Forwarded brand emails: customers forward to  <local>+<token>@<domain>  built from this address.
  // Your inbound-mail provider posts each email to  POST /api/inbound/email  with INBOUND_EMAIL_SECRET.
  // With INBOUND_EMAIL_DOMAIN (your own mail subdomain, MX pointed at the provider) each customer gets <token>@<domain>.
  inboundEmail: {
    domain: process.env.INBOUND_EMAIL_DOMAIN || '',
    address: process.env.INBOUND_EMAIL_ADDRESS || '',
    secret: process.env.INBOUND_EMAIL_SECRET || '',
  },
  // Sending email from the customer's Inbox (Postmark outbound). The sender domain must be verified in Postmark.
  outboundEmail: {
    postmarkToken: (process.env.POSTMARK_SERVER_TOKEN || process.env.POSTMARK_API_KEY || '').trim(),
    stream: process.env.POSTMARK_MESSAGE_STREAM || 'outbound',
  },
  // Shopify brand stores ("Customise stitching with Stitch&Ship"). The app is created in the Shopify Partner dashboard with custom
  // distribution; each brand installs it through /api/shopify/auth?shop=<store>.myshopify.com. SECRETS: keep them in the server .env.
  shopify: {
    apiKey: (process.env.SHOPIFY_APP_API_KEY || '').trim(),
    apiSecret: (process.env.SHOPIFY_APP_API_SECRET || '').trim(),
    apiVersion: (process.env.SHOPIFY_API_VERSION || '2026-07').trim(),
    // the public address of THIS server (Shopify redirects the brand back to <appUrl>/api/shopify/auth/callback)
    appUrl: (process.env.SHOPIFY_APP_URL || '').trim().replace(/\/$/, ''),
    scopes: (process.env.SHOPIFY_SCOPES || 'read_orders,write_orders,read_products,read_customers,read_merchant_managed_fulfillment_orders,write_merchant_managed_fulfillment_orders').trim(),
    // 32 bytes as base64 or 64 hex characters: encrypts the stores' access tokens in the database
    tokenKey: (process.env.SHOPIFY_TOKEN_KEY || '').trim(),
  },
  // Text messages (optional): Twilio's REST API. Off until the account details are set; each Shopify store also has its own switch.
  sms: {
    accountSid: (process.env.SMS_TWILIO_ACCOUNT_SID || '').trim(),
    authToken: (process.env.SMS_TWILIO_AUTH_TOKEN || '').trim(),
    from: (process.env.SMS_FROM || '').trim(),
    messagingServiceSid: (process.env.SMS_MESSAGING_SERVICE_SID || '').trim(),
    // the country used to read a number written without "+" (only Pakistan is understood: 03xx xxxxxxx)
    defaultCountry: (process.env.SMS_DEFAULT_COUNTRY || 'PK').trim().toUpperCase(),
  },
  // Emails the platform sends by itself (sign-in codes, "add your sizes"). Uses the same Postmark server as the Inbox.
  transactionalEmail: {
    from: (process.env.TRANSACTIONAL_EMAIL_FROM || '').trim(),
  },
  // Push notifications (Firebase Cloud Messaging). The service account is a SECRET: keep it in the server .env only.
  // Give it as FIREBASE_SERVICE_ACCOUNT_JSON (the JSON, one line), _BASE64, or _PATH (a file outside the repo).
  firebase: {
    serviceAccountJson: process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '',
    serviceAccountBase64: process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || '',
    serviceAccountPath: process.env.FIREBASE_SERVICE_ACCOUNT_PATH || '',
  },
  urls: {
    // Production defaults match the live sites, so Google sign-in works even when the server .env does not set these
    clientApp: process.env.CLIENT_APP_URL || (process.env.NODE_ENV === 'production' ? 'https://client.stitchnship.com' : 'http://localhost:4201'),
    adminApp: process.env.ADMIN_APP_URL || (process.env.NODE_ENV === 'production' ? 'https://admin.stitchnship.com' : 'http://localhost:4200'),
  },
};

// Validate critical environment variables
const requiredEnvVars = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY'];
const missingVars = requiredEnvVars.filter((v) => !process.env[v]);

if (missingVars.length > 0) {
  console.warn(`[Config Warning]: Missing required environment variables: ${missingVars.join(', ')}`);
}
