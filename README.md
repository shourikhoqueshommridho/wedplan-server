# WedPlan Server

## 1. Project Name and Description

**WedPlan** is a wedding planning platform that connects couples with trusted wedding service vendors.

This repository contains the **Express.js backend**, which powers the platform's authentication, service marketplace, booking workflow, vendor tools, admin dashboard APIs, image uploads, and subscription/payment processing.

The backend uses MongoDB as its primary database and communicates with the separate Next.js frontend.

**Client Repository:**  
https://github.com/shourikhoqueshommridho/wedplan-client

## 2. Important Features

The following backend features are implemented:

| Area | Features |
|---|---|
| Health Check | API health endpoint for deployment and server availability checks. |
| Authentication | Better Auth email/password authentication, optional Google OAuth, JWT authentication, and JWKS verification. |
| Authorization & Security | Role-based access control for customers, vendors, and admins; blocked-account protection; CORS; Helmet; rate limiting; Zod validation; and sanitized error responses. |
| Service Marketplace | Public service listing, search, category and location filtering, price sorting, and service details. Only approved and active services are publicly available. |
| Booking Management | Booking requests, ownership verification, self-booking prevention, duplicate active-booking protection, and booking status management. |
| Vendor Management | Vendor profile management, service creation, editing, deletion, delisting, and reactivation. |
| Image Uploads | Server-side ImgBB image uploads with file type validation and a 5 MB upload limit. |
| Admin Management | User search and management, account blocking/unblocking, service approval/rejection/deletion, booking management, transaction listing, and dashboard statistics. |
| Premium Subscription | Stripe-hosted Checkout, Premium subscription management, checkout reservation protection, and Stripe idempotency handling. |
| Webhook Processing | Verified Stripe webhook events, event idempotency, transaction deduplication, and subscription status updates. |
| Database Management | MongoDB collections, database indexes, and consistency safeguards. |

**Payment Note:** Failed payments and subscription cancellations are handled. Refund webhook events are not currently processed.

### Database Collections

The application uses the following MongoDB collections:

- `users`
- `sessions`
- `accounts`
- `verifications`
- `jwks`
- `services`
- `bookings`
- `transactions`
- `stripe_events`
- `subscriptions`
- `vendor_profiles`

## 3. Technology Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js |
| Backend Framework | Express.js 5.3.0 |
| Language | TypeScript 7.0.2 |
| Database | MongoDB Driver 7.9.0 |
| Authentication | Better Auth 1.7.25 |
| JWT Verification | JOSE 6.2.17 |
| Validation | Zod 4.6.7 |
| Security | Helmet 8.3.0, CORS 2.8.6, Express Rate Limit 8.7.4 |
| Image Upload | Multer 2.5.0, ImgBB API |
| Payment Processing | Stripe 23.1.0 |
| Environment Configuration | dotenv 18.0.10 |
| Testing | Node.js Built-in Test Runner |
| Development Tool | tsx 4.23.15 |

**Prerequisites:**

- Node.js 22 LTS recommended.
- npm 10 or later.
- MongoDB database (MongoDB Atlas recommended).
- Stripe account for payment functionality.
- ImgBB API key for image uploads.

The project was developed and tested locally with Node.js `22.23.5` and npm `10.9.9`.

## 4. Installation Instructions

### Clone the Repository

```bash
git clone https://github.com/shourikhoqueshommridho/wedplan-server.git
```

Navigate to the server directory:

```bash
cd wedplan-server
```

Install dependencies:

```bash
npm install
```

### Configure Environment Variables

Create a local environment file by copying the example file.

**Windows PowerShell:**

```powershell
Copy-Item .env.example .env
```

**macOS / Linux:**

```bash
cp .env.example .env
```

Add the required configuration values to `.env`.

### Environment Variables

The following environment variables are used by the backend:

| Variable | Required | Example | Purpose |
|---|---|---|---|
| `PORT` | No | `5000` | Server port. Defaults to 5000. |
| `NODE_ENV` | No | `development` | Application environment. |
| `CLIENT_URL` | Yes in production | `https://your-client-domain.com` | Frontend origin for CORS and authentication/payment URLs. |
| `BETTER_AUTH_URL` | Yes in production | `https://your-client-domain.com` | Frontend origin that serves Better Auth endpoints. |
| `BETTER_AUTH_SECRET` | Yes | `<your-secure-secret>` | Better Auth encryption and signing secret. |
| `GOOGLE_CLIENT_ID` | For Google OAuth | `<google-client-id>` | Google OAuth client ID. |
| `GOOGLE_CLIENT_SECRET` | For Google OAuth | `<google-client-secret>` | Google OAuth client secret. |
| `MONGODB_URI` | Yes | `<your-mongodb-connection-string>` | MongoDB connection string. |
| `MONGODB_DB` | No | `wedplan` | Database name. |
| `JWT_ISSUER` | Yes for Bearer authentication | `wedplan` | JWT issuer. |
| `JWT_AUDIENCE` | Yes for Bearer authentication | `wedplan-api` | JWT audience. |
| `JWKS_URL` | No | `https://your-client-domain.com/api/auth/jwks` | Public JWKS endpoint. |
| `STRIPE_SECRET_KEY` | For payments | `<your-stripe-secret-key>` | Stripe API secret key. |
| `STRIPE_WEBHOOK_SECRET` | For payments | `<your-webhook-signing-secret>` | Stripe webhook signature verification. |
| `STRIPE_PREMIUM_PRICE_ID` | For payments | `<your-stripe-price-id>` | Premium subscription price ID. |
| `IMGBB_API_KEY` | For uploads | `<your-imgbb-api-key>` | ImgBB image upload API key. |
| `STRIPE_CHECKOUT_DIAGNOSTICS` | No | `1` | Optional checkout diagnostics. |
| `VERCEL_URL` | Deployment-provided | — | Automatically provided by Vercel, when applicable. |
| `VERCEL_PRODUCTION_URL` | Deployment-provided | — | Automatically provided by Vercel, when applicable. |

**Security Notes:**

- Never commit `.env` or other environment files to GitHub.
- Never expose backend secrets through frontend `NEXT_PUBLIC_` variables.
- Keep MongoDB, Stripe, ImgBB, Better Auth, Google OAuth, and webhook credentials private.
- Use secure, unique secrets in production.
- Configure production environment variables through the hosting provider.

### Stripe Webhook Configuration

For payment processing, configure the following webhook endpoint in your Stripe Dashboard:

```text
POST https://your-backend-domain.com/api/stripe/webhook
```

The backend processes these Stripe events:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`

Replace the example backend domain with your actual deployed backend URL.

## 5. How to Run the Project Locally

Make sure MongoDB and the required environment variables are configured before starting the server.

### Start the Backend

From the `wedplan-server` directory, run:

```bash
npm run dev
```

The backend API will start at:

```text
http://localhost:5000
```

The default port is `5000`. It can be changed through the `PORT` environment variable.

### Start the Frontend

Open another terminal and navigate to the `wedplan-client` directory:

```bash
cd ../wedplan-client
npm install
npm run dev
```

Open the application:

```text
http://localhost:3000
```

The frontend communicates with the backend through Next.js API proxy routes.

### Available Backend Scripts

| Command | Description |
|---|---|
| `npm run dev` | Starts the backend development server using tsx watch mode. |
| `npm test` | Runs the automated test suite. |
| `npm run build` | Compiles TypeScript into the `dist/` directory. |
| `npm start` | Starts the compiled production server. |
| `npm run set-role -- <email> <customer\|vendor\|admin>` | Assigns a user role through a trusted server-side utility. |

**Local Development Example:**

To assign a role to an existing test account:

```bash
npm run set-role -- vendor@example.test vendor
```

Use an existing test account and only run this utility when you intentionally need to change its role.

## 6. Live Website Link

**Live Application:**  
https://wedplan-client-zeta.vercel.app

The live application uses the separate backend API configured through the deployment environment.

The backend's public production URL is not documented here because it has not been independently verified.

## 7. Client and Server Repository Links

| Repository | URL |
|---|---|
| Client Repository | https://github.com/shourikhoqueshommridho/wedplan-client |
| Server Repository | https://github.com/shourikhoqueshommridho/wedplan-server |

---

## API Architecture

The backend organizes its API routes under the `/api` prefix.

| Method & Endpoint | Module | Description |
|---|---|---|
| `GET /api/health` | Application | Public health check. |
| `ALL /api/auth/*` | Better Auth | Authentication, sessions, OAuth, JWT, and JWKS endpoints. |
| `POST /api/stripe/webhook` | Stripe | Verified Stripe webhook processing. |
| `GET /api/services` | Services | Public service listing. |
| `GET /api/services/:id` | Services | Service details. |
| `/api/account/*` | Account | Vendor registration, session information, and account-related operations. |
| `/api/vendor/*` | Vendor | Vendor profile and service management. |
| `POST /api/vendor/image` | Vendor Uploads | ImgBB image upload. |
| `/api/bookings/*` | Bookings | Booking creation, listing, and status management. |
| `/api/stripe/*` | Stripe | Premium Checkout and subscription information. |
| `/api/admin/*` | Admin | Administrative user, service, transaction, overview, and booking management. |

All API responses follow a consistent JSON response structure. Errors use appropriate HTTP status codes and do not expose internal messages or database connection details.

## Build and Production Instructions

Run the following commands to verify and build the backend:

```bash
npm install
npm test
npx tsc --noEmit
npm run build
```

Start the production server:

```bash
npm start
```

The TypeScript build outputs compiled JavaScript into the `dist/` directory.

### Deployment Notes

The backend is designed to run as a **long-running Node.js application** on a compatible hosting platform, such as Render, Railway, or a VM/container environment.

It uses `app.listen()`, maintains a reusable MongoDB connection, initializes database indexes at startup, and supports graceful shutdown.

**Important:** This backend is not currently structured as a Vercel serverless function. Deploying it to Vercel Functions would require a separate serverless adapter and architecture changes.

Configure all required environment variables in the hosting provider before starting the production server.

Never include production credentials or secret keys in source control.