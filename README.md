# Spice Route Restaurant Ordering App

Complete restaurant workflow with a customer landing page, phone/OTP login, menu ordering, UPI QR or cash checkout, customer sessions, SQLite persistence, and a staff console.

## Run

Requirements: Node.js 18+ and the installed `better-sqlite3` dependency.

```powershell
cd restaurant-whatsapp-mvp
npm start
```

Open <http://localhost:3010>.

## Try the flows

1. **Customer account:** choose Login or Sign up, enter a phone number, request an OTP, and verify it. With Twilio configured, the OTP is delivered by SMS.
2. **Customer ordering:** choose menu items, adjust the cart, select delivery/pickup, place an order, and choose UPI QR or cash on delivery.
3. **Staff dashboard:** select **Staff dashboard**, then sign in with `admin@spiceroute.local` / `demo123`. Move orders through confirmation, kitchen, ready, dispatch, and completed states.
4. **Inbox:** send simulated inbound messages with the API and reply from the inbox.
5. **Menu and reports:** add menu items, pause/enable availability, and review paid revenue, average order value, order counts, and top items.

## API

Useful endpoints include `GET /api/health`, `/api/menu`, `/api/dashboard`, `/api/reports`, `POST /api/orders`, `POST /api/orders/:id/pay`, `PATCH /api/orders/:id/status`, `POST /api/messages`, and `POST /api/auth/login`.

```powershell
Invoke-RestMethod http://localhost:3010/api/health
Invoke-RestMethod http://localhost:3010/api/messages -Method Post -ContentType "application/json" -Body '{"phone":"+91 90000 00001","text":"Can I add one Coke?"}'
```

## Real SMS OTP

Set these environment variables before starting the server:

```powershell
$env:TWILIO_ACCOUNT_SID="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
$env:TWILIO_AUTH_TOKEN="your_private_auth_token"
$env:TWILIO_PHONE_NUMBER="+1234567890"
$env:NODE_ENV="production"
npm start
```

Without Twilio credentials, local development uses OTP `123456`. Never commit Twilio credentials.
