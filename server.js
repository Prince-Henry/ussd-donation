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

// Statuses from Paystack that mean "a real payment request now exists and
// the donor can go approve it" - anything else (e.g. "send_otp") means the
// charge is stuck and nothing was actually sent, so we must NOT tell the
// donor it succeeded.
const CHARGE_SENT_STATUSES = new Set(['pay_offline', 'pending', 'success']);

// How to find and approve a pending request on each network. This is shown
// as the MAIN instruction, not a fallback - a system pop-up isn't guaranteed
// to appear (that depends on the donor's phone/SIM support, not this app),
// so donors should expect to check this menu rather than wait for a prompt.
// MTN's is confirmed working; Telecel and AirtelTigo's exact submenu option
// numbers are unconfirmed as of writing - update once tested.
const APPROVAL_INSTRUCTIONS = {
  MTN: 'dial *170#, select option 6, then option 3 to approve the payment',
  VODAFONE: 'dial *110# and look for the option to approve a pending request',
  AIRTELTIGO: 'dial *110# and look for the option to approve a pending request'
};

function approvalInstructionFor(network) {
  return APPROVAL_INSTRUCTIONS[network] || 'check your mobile money menu for a pending payment request to approve';
}

function successMessage(amount, network) {
  return `Thank you! To complete your GHS ${amount} donation via ${network}, ${approvalInstructionFor(network)}. A prompt may also appear automatically on your phone.`;
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
        const chargeResult = await requestMobileMoneyPayment({ phoneNumber: msisdn, amount: state.amount, network: net });

        if (!CHARGE_SENT_STATUSES.has(chargeResult.status)) {
          // e.g. status "send_otp" - this network needs a code we can't
          // collect inside a USSD session. Be honest rather than claiming
          // success. See README for why Vodafone/Telecel commonly hits this.
          console.error(`Charge not completed for ${net}, status: ${chargeResult.status}`);
          return reply('Sorry, this donation could not be completed automatically on this network right now. Please try again later or use a different network.', false);
        }

        return reply(successMessage(state.amount, net), false);
      }

      default: {
        sessions.delete(sessionID);
        return reply('Session expired. Please dial again.', false);
      }
    }
  } catch (err) {
    if (err.response && err.response.data) {
      console.error('USSD handler error:', err.message, '| Provider response:', JSON.stringify(err.response.data));
    } else {
      console.error('USSD handler error:', err.message);
    }
    sessions.delete(sessionID);
    return reply('Sorry, something went wrong processing your donation. Please try again later.', false);
  }
});

// ---- Payment: Paystack mobile money charge ----
// Attempted for all networks (MTN, AirtelTigo, Vodafone/Telecel). Vodafone
// currently tends to come back needing an OTP we can't collect in USSD -
// see the status check above and the README for details and next steps.
// Paystack expects the LOCAL Ghana format, e.g. 0551234987.
// Arkesel sends msisdn in international format, e.g. 233551234987 (no +).
function toLocalGhanaFormat(phoneNumber) {
  const digits = (phoneNumber || '').replace(/\D/g, '');
  if (digits.startsWith('233') && digits.length === 12) {
    return '0' + digits.slice(3);
  }
  if (digits.startsWith('0') && digits.length === 10) {
    return digits;
  }
  return digits;
}

async function requestMobileMoneyPayment({ phoneNumber, amount, network }) {
  const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
  if (!PAYSTACK_SECRET_KEY) {
    throw new Error('Payment provider is not configured (set PAYSTACK_SECRET_KEY)');
  }

  const providerMap = { MTN: 'mtn', AIRTELTIGO: 'atl', VODAFONE: 'vod' };
  const localPhone = toLocalGhanaFormat(phoneNumber);

  const { data } = await axios.post(
    'https://api.paystack.co/charge',
    {
      // Paystack requires a syntactically valid email even though we don't have
      // a real one for USSD donors. Use a real domain you own if possible.
      email: `donor.${localPhone}@example.com`,
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

  return data; // { status, reference, ... } - status checked by caller above
}

app.get('/', (req, res) => {
  res.send('USSD donation endpoint is running. Point Arkesel\'s callback URL to POST /ussd');
});

app.listen(PORT, () => {
  console.log(`USSD server listening on port ${PORT}`);
});
