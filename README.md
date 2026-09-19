# Campaign USSD Donation Endpoint (Arkesel + Paystack)

A USSD backend for a campaign donation menu, built for Arkesel's USSD gateway:

```
1. Donate
2. About Campaign
```

Selecting **Donate** asks for an amount, confirms the mobile money network
(read automatically from Arkesel's `network` field), then attempts an
automatic payment request via Paystack on **all three networks** (MTN,
AirtelTigo, Vodafone/Telecel). There is no manual "send to a different
number" workaround - every donation goes through the same tracked,
in-system channel, or the donor is told honestly that it couldn't be
completed automatically right now.

## Why donors are told to dial a code, not just "wait for a prompt"

Whether an automatic pop-up appears on a donor's phone for a pending mobile
money request depends on that phone's SIM Toolkit support - something
neither this app nor Paystack (or any aggregator) controls. Rather than
implying a guaranteed automatic prompt and leaving donors confused when
none appears, the success message now leads with how to find and approve
the request manually (e.g. `*170#` → 6 → 3 for MTN), and mentions that a
prompt may also appear automatically as a bonus, not the expectation.

## Why Vodafone/Telecel sometimes still fails

Paystack's mobile money charge can come back with a status of `send_otp`
instead of a normal "prompt sent" status - this means Vodafone/Telecel
(and occasionally other networks) require an SMS one-time code to be typed
back into whatever app started the charge. That works on a web checkout
page but not inside a live USSD session, which can't reliably be
backgrounded to read a text message without losing the session.

This app now **checks Paystack's actual response status** before telling
the donor anything succeeded. If the charge comes back needing an OTP (or
any status other than a real "prompt sent" state), the donor is told
plainly that the donation couldn't be completed automatically right now,
rather than being falsely told a payment prompt was sent. This is more
honest than the previous behavior, which didn't check status at all.

**Fully resolving Vodafone/Telecel automatically** (rather than just
failing gracefully) needs a provider whose Vodafone integration doesn't
route through this OTP step at all - Hubtel's Receive Money API is the one
confirmed example (it works like a mobile money agent request rather than
a raw merchant charge). That still requires a verified Hubtel merchant
account. When you're ready to set that up, the change is isolated to the
payment function - the rest of the USSD flow stays the same.

## How Arkesel's USSD API works

Arkesel POSTs **JSON** and only sends the *latest* input in `userData` (not
the full accumulated string like some other gateways), so this app tracks
each session's progress in memory, keyed by `sessionID`.

Request Arkesel sends you:
```json
{
  "sessionID": "2005506191900168",
  "userID": "YOUR_USSD_APP_ID",
  "newSession": true,
  "msisdn": "233551234987",
  "userData": "1",
  "network": "MTN"
}
```

Response your app sends back:
```json
{
  "sessionID": "2005506191900168",
  "userID": "YOUR_USSD_APP_ID",
  "msisdn": "233551234987",
  "message": "Enter amount to donate (GHS):",
  "continueSession": true
}
```

## 1. Install and run locally

```bash
npm install
cp .env.example .env   # then fill in your real values
npm start
```

## 2. Deploy

Push to GitHub, connect to Render, set `PAYSTACK_SECRET_KEY` in Render's
environment variables, deploy.

## 3. Register with Arkesel

Set your Arkesel USSD callback URL to:
```
https://your-app-name.onrender.com/ussd
```

## Notes

- The in-memory `sessions` Map works for a single server instance. If you
  scale to multiple instances, move session state to Redis or a database.
- Telecel and AirtelTigo's exact approval-menu option numbers (the specific
  numbers to press after dialing `*110#`) are unconfirmed - only MTN's
  `*170#` → 6 → 3 has been tested. Once you test a real donation on those
  two networks, send me the exact menu wording and I'll update
  `APPROVAL_INSTRUCTIONS` in `server.js` with the precise steps.
- Watch Render's Logs tab for `Charge not completed for ...` lines - these
  tell you which network and status caused an automatic donation to fail,
  which is useful for tracking how often Vodafone/Telecel donors are
  currently being turned away.
