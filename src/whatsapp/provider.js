// ============================================================================
// clinic-automation — WhatsApp Cloud API provider (src/whatsapp/provider.js)
// Purpose: hide Meta's API behind small functions so everything else stays
//   testable. MOCK_MODE=true (default, local dev) logs the payload and
//   returns a fake id — no network, no cost. MOCK_MODE=false POSTs to
//   https://graph.facebook.com/{apiVersion}/{phoneNumberId}/messages.
//   sendText   — plain text, or an interactive button message when
//                quickReplies are passed (CONFIRM/CANCEL/RESCHEDULE).
//   sendMedia  — document message, used by receipts.js for PDF receipts.
// Deps: ../config.js (whatsapp.*). Uses global fetch (Node >= 20).
// Env: WHATSAPP_MOCK_MODE, WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID,
//   WHATSAPP_API_VERSION. Zero new dependencies.
// Error contract: live-mode transport/API failures THROW (Error with
// 'WhatsApp API {status}: ...'). messaging.js catches, logs status 'failed',
// and escalates to the owner — so callers must treat send* as fallible and
// never let a throw break the booking/webhook flow. MOCK mode never throws
// for transport reasons (only for missing toPhone/link validation).
// ============================================================================
'use strict';

function isMock() {
  return getWaConfig().mockMode === true;
}

function getWaConfig() {
  try {
    return require('../config').getConfig().whatsapp;
  } catch (_) {
    return { mockMode: true, token: '', phoneNumberId: '', apiVersion: 'v21.0', verifyToken: '' };
  }
}

async function postToCloudApi(payload) {
  const cfg = getWaConfig();
  const url = `https://graph.facebook.com/${cfg.apiVersion}/${cfg.phoneNumberId}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`WhatsApp API ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  const id = data && data.messages && data.messages[0] && data.messages[0].id;
  return { id: id || null, raw: data };
}

async function sendText(toPhone, body, { quickReplies = [] } = {}) {
  const normalized = String(toPhone || '').trim();
  if (!normalized) throw new Error('toPhone is required');
  if (getWaConfig().mockMode) {
    return { id: `mock-${Date.now()}`, mocked: true };
  }
  // With quick replies, send a real interactive button message so clients
  // can tap CONFIRM / CANCEL / RESCHEDULE. The webhook parser accepts both
  // button_reply ids and plain-text keywords, so taps and typed replies
  // behave identically (see routes/webhook.js parseInbound).
  if (quickReplies.length) {
    return sendInteractive(normalized, body, quickReplies);
  }
  const { id } = await postToCloudApi({
    messaging_product: 'whatsapp',
    to: normalized,
    type: 'text',
    text: { body },
  });
  return { id, mocked: false };
}

// Interactive quick-reply buttons (Cloud API `type: interactive`).
// Cloud API allows max 3 reply buttons; button `id` is the payload echoed
// back in the webhook, so ids ARE the CONFIRM/CANCEL/RESCHEDULE keywords.
async function sendInteractive(toPhone, bodyText, quickReplies = []) {
  const normalized = String(toPhone || '').trim();
  if (!normalized) throw new Error('toPhone is required');
  const replies = [...new Set(quickReplies.map((r) => String(r || '').trim().toUpperCase()).filter(Boolean))].slice(0, 3);
  if (!replies.length) return sendText(normalized, bodyText);
  if (getWaConfig().mockMode) {
    return { id: `mock-interactive-${Date.now()}`, mocked: true };
  }
  const { id } = await postToCloudApi({
    messaging_product: 'whatsapp',
    to: normalized,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: String(bodyText || '') },
      action: {
        buttons: replies.map((reply, i) => ({
          type: 'reply',
          reply: { id: reply, title: reply.slice(0, 20) || `OPTION_${i + 1}` },
        })),
      },
    },
  });
  return { id, mocked: false };
}

async function sendMedia(toPhone, { link, filename = 'document.pdf', caption = '' } = {}) {
  const normalized = String(toPhone || '').trim();
  if (!normalized) throw new Error('toPhone is required');
  if (!link) throw new Error('media link is required');
  if (getWaConfig().mockMode) {
    return { id: `mock-media-${Date.now()}`, mocked: true };
  }
  const { id } = await postToCloudApi({
    messaging_product: 'whatsapp',
    to: normalized,
    type: 'document',
    document: { link, filename, caption },
  });
  return { id, mocked: false };
}

// sendDocument — canonical document-send name (M4 contract). Same as
// sendMedia; both kept because receipts.js calls sendMedia directly.
async function sendDocument(toPhone, fileUrlOrOpts, captionOrFilename) {
  if (typeof fileUrlOrOpts === 'object' && fileUrlOrOpts !== null) {
    return sendMedia(toPhone, fileUrlOrOpts);
  }
  return sendMedia(toPhone, {
    link: fileUrlOrOpts,
    filename: captionOrFilename || 'document.pdf',
    caption: '',
  });
}

module.exports = { isMock, sendText, sendInteractive, sendMedia, sendDocument, getWaConfig };
