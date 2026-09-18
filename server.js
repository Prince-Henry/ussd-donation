require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const CAMPAIGN_NAME = process.env.CAMPAIGN_NAME || 'Our Campaign';
const ABOUT_TEXT = process.env.ABOUT_TEXT ||
  'This campaign supports [your cause here]. Every donation helps us reach our goal.';

// ---- In-memory session store ----
// Arkesel only sends the LATEST input in `userData`, not the full accumulated
// string (unlike Africa's Talking). So we track each session's progress here.
// For production with more than one server instance, replace this Map with
// Redis or another shared store keyed by sessionID.
const sessions = new Map();

// Arkesel's `network` field already tells us MTN / VODAFONE / AIRTELTIGO,
// so we don't need to ask the donor to pick it from a menu.
function normalizeNetwork(network) {
  const n = (network || '').toUpperCase();
  if (n.includes('MTN')) return 'MTN';
  if (n.includes('VODAFONE') || n.includes('TELECEL')) return 'VODAFONE';
  if (n.includes('AIRTEL') || n.includes('TIGO')) return 'AIRTELTIGO';
  return n || 'UNKNOWN';
}

function isValidAmount(amount) {
  const n = Number(amount);
  return !isNaN(n) && n > 0;
}

app.post('/ussd', async (req, res) => {
  const { sessionID, userID, newSession, msisdn, userData, network } = req.body;

  const reply = (message, continueSession) => {
    res.json({ sessionID, userID, msisdn, message, continueSession });
  };

  try {
    // Start of a new session: reset state and show the main menu
    if (newSession) {
      sessions.set(sessionID, { step: 'menu' });
      return reply(`Welcome to ${CAMPAIGN_NAME}\n1. Donate\n2. About Campaign`, true);
    }

    const state = sessions.get(sessionID) || { step: 'menu' };
    const input = (userData || '').trim();

    switch (state.step) {
      case 'menu': {
        if (input === '1') {
          state.step = 'amount';
          sessions.set(sessionID, state);
          return reply('Enter amount to donate (GHS):', true);
        }
        if (input === '2') {
          sessions.delete(sessionID);
          return reply(ABOUT_TEXT, false);
        }
        sessions.delete(sessionID);
        return reply('Invalid option. Please dial again.', false);
      }

      case 'amount': {
        if (!isValidAmount(input)) {
          sessions.delete(sessionID);
          return reply('Invalid amount. Please dial again and enter a number, e.g. 20', false);
        }
        state.amount = input;
        state.step = 'confirm';
        sessions.set(sessionID, state);
        const net = normalizeNetwork(network);
        return reply(
          `Confirm: donate GHS ${input} via ${net} Mobile Money?\n1. Confirm\n2. Cancel`,
          true
        );
      }

      case 'confirm': {
        sessions.delete(sessionID);
        if (input !== '1') {
          return reply('Donation cancelled.', false);
        }
        const net = normalizeNetwork(network);
        await requestMobileMoneyPayment({ phoneNumber: msisdn, amount: state.amount, network: net });
        return reply(
          `Thank you! A payment prompt of GHS ${state.amount} has been sent to your phone via ${net}. Please approve it to complete your donation.`,
          false
        );
      }

      default: {
        sessions.delete(sessionID);
        return reply('Session expired. Please dial again.', false);
      }
    }
  } catch (err) {
    // If this was an HTTP error from the payment provider, log the real
    // reason it gave (e.g. Paystack's error message), not just "status 400".
    if (err.response && err.response.data) {
      console.error('USSD handler error:', err.message, '| Provider response:', JSON.stringify(err.response.data));
    } else {
      console.error('USSD handler error:', err.message);
    }
    sessions.delete(sessionID);
    return reply('Sorry, something went wrong processing your donation. Please try again later.', false);
  }
});

// ---- Payment plug-in point ----
// IMPORTANT: Arkesel's public docs don't clearly spec a mobile-money charge
// endpoint at the time this was written. Before going live, get the exact
// endpoint/payload from your Arkesel dashboard's Payment API section, or
// swap this out for a gateway you already use (Paystack, Hubtel, Flutterwave).
// This function is written for Paystack's Ghana mobile money charge as a
// working placeholder — replace with your actual provider's call.
// Paystack expects the LOCAL Ghana format, e.g. 0551234987.
// Arkesel sends msisdn in international format, e.g. 233551234987 (no +).
// Passing the international format straight to Paystack causes a 400 error.
function toLocalGhanaFormat(phoneNumber) {
  const digits = (phoneNumber || '').replace(/\D/g, ''); // strip any non-digits, e.g. a leading +
  if (digits.startsWith('233') && digits.length === 12) {
    return '0' + digits.slice(3);
  }
  if (digits.startsWith('0') && digits.length === 10) {
    return digits; // already local format
  }
  return digits; // fallback: pass through as-is so the error (if any) is visible in logs
}

async function requestMobileMoneyPayment({ phoneNumber, amount, network }) {
  const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
  if (!PAYSTACK_SECRET_KEY) {
    throw new Error('Payment provider is not configured (set PAYSTACK_SECRET_KEY or wire up your provider)');
  }

  const providerMap = { MTN: 'mtn', VODAFONE: 'vod', AIRTELTIGO: 'atl' };
  const localPhone = toLocalGhanaFormat(phoneNumber);

  const { data } = await axios.post(
    'https://api.paystack.co/charge',
    {
      email: `${localPhone}@donor.placeholder`, // Paystack requires an email; use a placeholder or collect one
      amount: Number(amount) * 100, // Paystack expects amount in pesewas
      currency: 'GHS',
      mobile_money: {
        phone: localPhone,
        provider: providerMap[network] || 'mtn'
      }
    },
    {
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );

  return data;
}

app.get('/', (req, res) => {
  res.send('USSD donation endpoint is running. Point Arkesel\'s callback URL to POST /ussd');
});

app.listen(PORT, () => {
  console.log(`USSD server listening on port ${PORT}`);
});
