/**
 * EasyData GH — /api/purchase.js
 * Vercel Serverless Function (Node.js 18+ runtime)
 */

const { createClient } = require('@supabase/supabase-js');

// REMOVED: const fetch = require('node-fetch'); 
// Node 18+ provides fetch globally. Adding the require line causes the crash you saw.

// ── NetgearGH constants ───────────────────────────────────────────────────────
const NG_BASE       = 'https://netgeargh.app/api/v1';
const NG_TIMEOUT_MS = 25000; 
const NG_NETWORK_IDS = { mtn: 3, telecel: 2, at: 1 };

// ── Helpers ───────────────────────────────────────────────────────────────────

function setHeaders(res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function send(res, status, body) {
  setHeaders(res);
  res.status(status).json(body);
}

async function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk.toString(); });
    req.on('end', () => {
      try { resolve(JSON.parse(raw)); }
      catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

async function fetchTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    // Uses the NATIVE Node 18 fetch
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function callNetgear(network, phone, volumeMB, orderRef) {
  const key = process.env.NETGEAR_API_KEY;
  if (!key) throw new Error('NETGEAR_API_KEY env var is not set');

  const headers = {
    'api-key':      key,
    'Accept':       'application/json',
    'Content-Type': 'application/json',
  };

  let endpoint, body;
  if (network === 'at') {
    endpoint = '/buy-ishare-package';
    body = { recipient_msisdn: phone, shared_bundle: volumeMB, order_reference: orderRef };
  } else {
    endpoint = '/buy-other-package';
    body = { recipient_msisdn: phone, network_id: NG_NETWORK_IDS[network], shared_bundle: volumeMB };
  }

  const res = await fetchTimeout(
    NG_BASE + endpoint,
    { method: 'POST', headers, body: JSON.stringify(body) },
    NG_TIMEOUT_MS
  );

  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); }
  catch { data = { _raw: text, _parseError: true }; }

  return { httpStatus: res.status, data };
}

function parseNetgearResponse(network, httpStatus, data) {
  let success, txnId, message;
  if (network === 'at') {
    const code = String(data.response_code || '');
    success = (code === '200' || httpStatus === 200) && !data.error;
    txnId   = data.vendorTranxId || '';
    message = data.response_msg  || '';
  } else {
    success = data.success === true && httpStatus === 200;
    txnId   = data.transaction_code || '';
    message = data.message          || '';
  }
  return { success, txnId, message };
}

function friendlyError(msg) {
  const m = (msg || '').toLowerCase();
  if (m.includes('does not exist')) return 'Number not found on this network.';
  if (m.includes('insufficient')) return 'Service temporarily unavailable.';
  if (m.includes('out of stock')) return 'Bundle size out of stock.';
  return msg || 'Delivery failed. Try again.';
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    setHeaders(res);
    return res.status(200).end();
  }

  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });

  try {
    const sb = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    const authRaw = req.headers['authorization'] || '';
    const token   = authRaw.replace(/^Bearer\s+/i, '').trim();
    const { data: authData, error: authErr } = await sb.auth.getUser(token);
    
    if (authErr || !authData?.user) return send(res, 401, { error: 'Session expired.' });
    
    const userId = authData.user.id;
    const body = await parseBody(req);
    const { network, size, validity, amount, recipient, mb, order_ref } = body;

    // Balance check
    const { data: profile } = await sb.from('profiles').select('balance').eq('id', userId).single();
    if (profile.balance < amount) return send(res, 402, { error: 'Insufficient balance' });

    // Deduct first (Safety)
    const newBalance = parseFloat((profile.balance - amount).toFixed(2));
    await sb.from('profiles').update({ balance: newBalance }).eq('id', userId);

    // Call Provider
    let ngResult = null;
    let networkFail = false;
    try {
      const { httpStatus, data } = await callNetgear(network, recipient, mb, order_ref);
      ngResult = parseNetgearResponse(network, httpStatus, data);
    } catch (e) {
      networkFail = true;
    }

    if (ngResult && ngResult.success) {
      await sb.from('transactions').insert({
        user_id: userId, type: 'purchase', network, size, amount, recipient, status: 'delivered', vendor_txn_id: ngResult.txnId
      });
      return send(res, 200, { success: true, new_balance: newBalance });
    }

    if (networkFail) {
      await sb.from('transactions').insert({
        user_id: userId, type: 'purchase', network, size, amount, recipient, status: 'pending', note: 'Check Netgear Console'
      });
      return send(res, 202, { message: 'Order pending manual verification.' });
    }

    // Refund if rejected
    const refundBalance = parseFloat((newBalance + amount).toFixed(2));
    await sb.from('profiles').update({ balance: refundBalance }).eq('id', userId);
    await sb.from('transactions').insert({
      user_id: userId, type: 'purchase', network, size, amount, recipient, status: 'failed'
    });

    return send(res, 422, { error: friendlyError(ngResult?.message) });

  } catch (err) {
    return send(res, 500, { error: 'Internal Server Error' });
  }
};
