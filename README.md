# Stitching as a Service - Backend API

A robust Node.js & Express.js REST API with Supabase Authentication, JWT verification middleware, role-based access control, Redis caching, and centralized error handling.

---

## 🚀 Features

- **Express 5 & ES Modules**: Clean, modern JavaScript backend architecture.
- **Supabase Integration**: Dual client setup (`public` client for client-facing auth and `admin` client with service-role privileges).
- **Authentication Middleware (`auth.middleware.js`)**:
  - Validates Bearer JWT tokens via Supabase Auth API (`getUser`).
  - Optional offline verification fallback using Remote JWKS (`jose`).
  - Extracts and attaches user profile, role, and ID to `req.user`, `req.userId`, and `req.userRole`.
- **Role-Based Authorization (`requireRole`)**: Protect endpoints for specific roles (`customer`, `tailor`, `admin`).
- **🛡️ Comprehensive Error Handling Helpers (`src/utils/error.helper.js`)**:
  - `catchAsync`: Eliminates repetitive try-catch blocks in async controllers.
  - Custom error classes: `AppError`, `BadRequestError`, `UnauthorizedError`, `ForbiddenError`, `NotFoundError`, `ConflictError`, `ValidationError`, `InternalServerError`.
  - `ApiResponse`: Standardized helper for sending uniform responses (`success`, `created`, `error`).
- **⚡ Redis Caching Helper (`src/utils/cache.helper.js`)**:
  - `CacheHelper.get(key)`, `set(key, val, ttl)`, `del(key)`, `delByPattern(pattern)`.
  - `CacheHelper.getOrSet(key, fetchFn, ttl)`: Non-intrusive Cache-Aside pattern.
  - `CacheHelper.routeCache(ttl, keyGen)`: Express middleware for route response caching.
  - **Graceful Degradation**: If Redis is offline or not configured, the app runs without crashing and bypasses caching automatically.

---

## 🔐 Access control (Admin → Partners → partner users)

- **Admin** creates **Partners** (each gets its own login, the *owner*) and chooses which modules each partner may use.
- A **Partner** creates its own users (master tailor, tailor, staff…) and chooses which of *its* modules each user gets.
- Permissions are `<module>.<action>` ids (`production.view`, `production.update`, `users.create`, …), see `src/config/permissions.js`.
  Effective permissions are computed on the server for every request: admin = everything, owner = the partner's modules,
  member = granted ∩ partner's modules. Nothing about role, partner or permissions is ever read from the request.
- Every `/api/partner/*` route needs its module permission and, when it takes an id, proves the record belongs to the caller's partner
  (`src/middlewares/ownership.middleware.js`). List queries are filtered by partner in the controllers. Row Level Security repeats the
  rule for direct database access (migration `0005_partners_rbac.sql`).
- There is **no public staff sign-up**. Create the first admin with `npm run admin:create -- you@company.com "Name" "password"`.
  Logins created by an admin/partner get a temporary password (shown once) that must be changed at first sign-in.
- `node scripts/audit-routes.mjs` lists the guard of every partner route and fails if one is unprotected; `npm run test:rbac` runs the
  end-to-end hierarchy / isolation test; `npm run db:bundle` rebuilds `SETUP_DATABASE.sql` and `UPDATE_DATABASE_<n>.sql` from the migrations.
- Order status is forward-only from `paid` onwards (service check + database trigger).

---

## 📁 Project Structure

```
backend/
├── .env                       # Environment variables (Supabase & Redis)
├── .env.example               # Template for environment variables
├── .gitignore                 # Git ignore file
├── package.json               # Dependencies and scripts
├── supabase_schema.sql        # Supabase PostgreSQL schema with profiles table, RLS & triggers
└── src/
    ├── app.js                 # Express application setup, middlewares, and route mounting
    ├── server.js              # Server entry point & graceful shutdown handling
    ├── config/
    │   ├── env.js             # Environment variable validation & exports
    │   ├── redis.js           # Redis client with retry strategy and error handling
    │   └── supabase.js        # Supabase public & admin client instances
    ├── controllers/
    │   └── auth.controller.js  # Controller logic (register, login, getMe, updateMe, logout, refresh)
    ├── middlewares/
    │   ├── auth.middleware.js # JWT Bearer token authentication & role authorization
    │   ├── error.middleware.js# 404 Not Found & global error handler
    │   └── validate.middleware.js # Request payload validation (email, password)
    ├── models/
    │   └── user.model.js      # User Model interacting with Supabase Auth & profile records
    ├── routes/
    │   ├── index.js           # Main API router (/api/health, /api/auth)
    │   └── auth.routes.js     # Authentication routes
    └── utils/
        ├── catchAsync.js      # Async handler wrapper
        ├── errors.js          # Custom AppError classes
        ├── error.helper.js    # Consolidated error exports
        ├── response.helper.js # Uniform ApiResponse helper
        └── cache.helper.js    # Redis cache service & route cache middleware
```

---

## 🛠️ Getting Started

### 1. Install Dependencies
```bash
npm install
```

### 2. Environment Configuration
The `.env` file is pre-configured:
```env
PORT=5000
NODE_ENV=development

SUPABASE_URL=https://your-supabase-project.supabase.co
SUPABASE_PUBLISHABLE_KEY=your_supabase_publishable_key
SUPABASE_SECRET_KEY=your_supabase_secret_key
SUPABASE_JWKS_URL=https://your-supabase-project.supabase.co/auth/v1/.well-known/jwks.json

# Redis Cache Configuration
REDIS_URL=
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_ENABLED=true
REDIS_DEFAULT_TTL=300
```
> **Note**: If you don't have a local Redis server running, the backend will automatically log a notice and continue running in cache-bypass mode without throwing errors. You can also point `REDIS_URL` to an Upstash or Redis Cloud URL.

### 3. Run the Server
- **Development Mode** (with auto-reload):
  ```bash
  npm run dev
  ```
- **Production Mode**:
  ```bash
  npm start
  ```

---

## 💡 How to Use the Helpers

### 1. Error Handling Helper (`catchAsync` & Custom Errors)

```javascript
import { catchAsync, BadRequestError, NotFoundError, ApiResponse } from '../utils/error.helper.js';

export const getOrder = catchAsync(async (req, res) => {
  const { id } = req.params;
  
  if (!id) {
    throw new BadRequestError('Order ID is required.');
  }

  const order = await OrderModel.findById(id);
  if (!order) {
    throw new NotFoundError(`Order with ID ${id} not found.`);
  }

  return ApiResponse.success(res, { order }, 'Order retrieved successfully.');
});
```

### 2. Redis Caching Helper (`CacheHelper`)

#### Cache-Aside Pattern:
```javascript
import CacheHelper from '../utils/cache.helper.js';

// Reads from cache; on miss, runs the async function and caches for 300 seconds
const userProfile = await CacheHelper.getOrSet(
  `user:profile:${userId}`,
  async () => await UserModel.findById(userId),
  300
);

// Delete cache upon updates
await CacheHelper.del(`user:profile:${userId}`);

// Delete by wildcard pattern (e.g. invalidating all catalog items)
await CacheHelper.delByPattern('catalog:*');
```

#### Route-Level Response Caching Middleware:
```javascript
import { CacheHelper } from '../utils/cache.helper.js';

// Caches GET /api/catalog for 60 seconds
router.get('/catalog', CacheHelper.routeCache(60), catalogController.list);
```

---

## 📚 API Endpoints

### Health Check
- **`GET /api/health`**
  - **Access**: Public
  - **Response**: `200 OK` (includes uptime and Redis status)

### Authentication Routes (`/api/auth`)

| Method | Endpoint | Access | Description |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/auth/register` | Public | Register new user with email, password, role |
| `POST` | `/api/auth/login` | Public | Login with email & password, returns JWT tokens |
| `GET` | `/api/auth/me` | Protected | Get profile of logged-in user (cached in Redis) |
| `PATCH`| `/api/auth/me` | Protected | Update profile (invalidates Redis user cache) |
| `POST` | `/api/auth/refresh` | Public | Refresh expired access token |
| `POST` | `/api/auth/logout` | Protected | Invalidate session & user cache |
