/**
 * EasyData GH — /api/purchase.js
 * Vercel Serverless Function (Node.js 18/24 runtime)
 * 
 * FINAL STEALTH VERSION: 
 * - Includes Browser Fingerprint headers to bypass Cloudflare
 * - Protects Owner Revenue (Deduct-before-call)
 * - Automated Auto-Refund for invalid inputs
 */

const { createClient } = require('@supabase/supabase-js');

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

// Mimic a modern Chrome Browser to fool Cloudflare Bot Detection
function buildStealthHeaders(key) {
  return {
    'x-api-key':         key,
    'User-Agent':        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    'Accept':            'application/json, text/plain, */*',
    'Accept-Language':   'en-GB,en-US;q=0.9,en;q=0.8',
    'Content-Type':      'application/json',
    // Tell Cloudflare this is coming from the Netgear site itself
    'Origin':            'https://netgeargh.app',
    'Referer':           'https://netgeargh.app/',
    // Browser security fingerprints
    'Sec-Ch-Ua':         '"Chromium";v="123", "Not:A-Brand";v="8", "Google Chrome";v="123"',
    'Sec-Ch-Ua-Mobile':  '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest':    'empty',
    'Sec-Fetch-Mode':    'cors',
    'Sec-Fetch-Site':    'same-origin',
    'Cache-Control':     'no-cache',
    'Pragma':            'no-cache'
  };
}

async function callNetgear(network, phone, mbValue, orderRef) {
  const key = process.env.NETGEAR_API_KEY;
  const headers = buildStealthHeaders(key);
  
  let endpoint, body;
  if (network === 'at') {
    endpoint = '/buy-ishare-package';
    body = { recipient_msisdn: phone, shared_bundle: mbValue, order_reference: orderRef };
  } else {
    endpoint = '/buy-other-package';
    body = { recipient_msisdn: phone, network_id: NG_NETWORK_IDS[network] || 3, shared_bundle: mbValue };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NG_TIMEOUT_MS);

  try {
    const res = await fetch(NG_BASE + endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });

    const text = await res.text();
    clearTimeout(timeout);

    // If the response contains HTML, Cloudflare blocked us
    if (text.includes('Just a moment') || text.includes('<!DOCTYPE html>')) {
      throw new Error('CLOUDFLARE_BLOCK');
    }

    let data = {};
    try { data = JSON.parse(text); } catch (e) { data = { _raw: text }; }
    
    return { status: res.status, data };
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('TIMEOUT');
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════════════════════════
module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') { setHeaders(res); return res.status(200).end(); }
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });

  try {
    // 1. Setup Supabase
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    
    // 2. Auth User
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '').trim();
    const { data: { user } } = await sb.auth.getUser(token);
    if (!user) return send(res, 401, { error: "Login required" });

    // 3. Parse Data
    const { network, size, amount, recipient, mb, order_ref } = req.body;
    const mbValue = parseInt(String(mb).replace(/\D/g, ''), 10);
    const orderRef = order_ref || `ED-${network}-${Date.now()}`;

    // 4. Check & Deduct Balance IMMEDIATELY (Owner Protection)
    const { data: profile } = await sb.from('profiles').select('balance').eq('id', user.id).single();
    if (!profile || profile.balance < amount) return send(res, 402, { error: "Insufficient balance" });

    const newBal = parseFloat((profile.balance - amount).toFixed(2));
    await sb.from('profiles').update({ balance: newBal }).eq('id', user.id);

    // 5. Try calling Netgear
    try {
      const { status, data } = await callNetgear(network, recipient, mbValue, orderRef);

      // CASE: SUCCESS
      if (data.response_code === "200" || data.success === true) {
        await sb.from('transactions').insert({
          user_id: user.id, type: 'purchase', network, size, amount, recipient, status: 'delivered', 
          vendor_txn_id: data.vendorTranxId || data.transaction_code, order_ref: orderRef
        });
        return send(res, 200, { success: true, new_balance: newBal });
      }

      // CASE: REFUNDABLE ERROR (User entered wrong number or size out of stock)
      const msg = (data.message || data.response_msg || "").toLowerCase();
      if (msg.includes("exist") || msg.includes("invalid") || msg.includes("stock")) {
        const refundBal = parseFloat((newBal + amount).toFixed(2));
        await sb.from('profiles').update({ balance: refundBal }).eq('id', user.id);
        await sb.from('transactions').insert({
          user_id: user.id, type: 'purchase', network, size, amount, recipient, status: 'failed', 
          api_message: msg, note: "Auto-refunded"
        });
        return send(res, 422, { error: "Invalid number. Money refunded." });
      }

      // OTHERWISE: Treat as server lag/maintenance (KEEP THE MONEY, MARK PENDING)
      throw new Error("PROVIDER_LAG");

    } catch (err) {
      // API FAILED (Maintenance, Timeout, or Cloudflare Block)
      // LOG AS PENDING: You have the money, bundle manually.
      await sb.from('transactions').insert({
        user_id: user.id, type: 'purchase', network, size, amount, recipient, status: 'pending', 
        order_ref: orderRef, note: "MANUAL BUNDLE REQUIRED: " + err.message
      });
      
      return send(res, 200, { 
        success: true, 
        new_balance: newBal, 
        message: "Processing manually due to network delay." 
      });
    }

  } catch (globalErr) {
    console.error("Global Error:", globalErr.message);
    return send(res, 500, { error: "Internal Server Error" });
  }
};
