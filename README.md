# Campaign USSD Donation Endpoint (Arkesel)

A USSD backend for a campaign donation menu, built for Arkesel's USSD gateway:

```
1. Donate
2. About Campaign
```

Selecting **Donate** asks for an amount, confirms the mobile money network
(read automatically from Arkesel's `network` field), and sends a mobile
money payment prompt to the donor's phone.

## How Arkesel's USSD API works (different from most others)

Arkesel POSTs **JSON**, not form fields, and only sends you the *latest*
key the donor pressed each time — not the whole dialed string. So this app
keeps track of where each session is using an in-memory map keyed by
`sessionID`.

Request Arkesel sends you:
```json
{
  "sessionID": "2005506191900168",
  "userID": "YOUR_USSD_APP_ID",
  "newSession": true,
  "msisdn": "233271231234",
  "userData": "1",
  "network": "MTN"
}
```

Response your app must send back:
```json
{
  "sessionID": "2005506191900168",
  "userID": "YOUR_USSD_APP_ID",
  "msisdn": "233271231234",
  "message": "Enter amount to donate (GHS):",
  "continueSession": true
}
```

Set `continueSession` to `false` when you want to end the session (Arkesel's
equivalent of Africa's Talking's `END`).

## 1. Install and run locally

```bash
npm install
cp .env.example .env   # then fill in your real values
npm start
```

The server exposes one route: `POST /ussd`.

## 2. Get a public URL

Deploy this to any host that can run Node (Render, Railway, Fly.io, your own
VPS). Once deployed you'll have something like:

```
https://your-app-name.onrender.com/ussd
```

## 3. Register with Arkesel

1. Log in to your Arkesel dashboard.
2. Go to **USSD → Manage Callbacks** (or similar, per current dashboard
   layout).
3. Set your callback URL to the deployed endpoint above.
4. Confirm your assigned USSD shortcode and `userID` (Arkesel issues this
   per USSD subscription — it's the value you should echo back in every
   response; set it if needed as an env var).
5. Test using the Arkesel sandbox/simulator tools in your dashboard before
   going live.

## Important: the mobile money charge itself

Arkesel's core, clearly documented products are SMS, OTP, and USSD. At the
time this was written I could not confirm a public, documented Arkesel
endpoint specifically for **charging mobile money** (their site lists
"Payment" as a feature area, but I don't have a verified spec for it). Two
options:

1. **Check your Arkesel dashboard** directly — if they do offer mobile
   money collection, the exact endpoint and payload will be there. If so,
   send me the details and I'll wire it into `requestMobileMoneyPayment()`
   in `server.js`.
2. **Use a payment gateway you already have** for the actual charge, while
   Arkesel just handles the USSD menu. I've wired the placeholder to
   **Paystack's** Ghana mobile money charge API as a working example — swap
   in Hubtel, Flutterwave, or whichever you use if not Paystack.

Either way, the USSD menu/session logic in `server.js` doesn't need to
change — only the `requestMobileMoneyPayment()` function does.

## Notes

- USSD sessions time out quickly (Arkesel's docs mention ~2.5 minutes of
  inactivity), so keep any external calls (like the payment charge) fast,
  and consider responding to the donor optimistically while the charge
  request is sent, then following up by SMS to confirm success/failure.
- The in-memory `sessions` Map works for a single server instance. If you
  deploy with multiple instances or auto-scaling, move session state to
  Redis or a database so all instances see the same session.
