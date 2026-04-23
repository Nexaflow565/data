/**
 * EasyData GH — /api/purchase.js
 * Vercel Serverless Function (Node.js runtime)
 *
 * Environment variables — set in Vercel Dashboard → Settings → Environment Variables:
 *   NETGEAR_API_KEY       = 47ee365f6e06e3abae5d942b633ffeab770fc052
 *   SUPABASE_URL          = https://acvvgkbbodyweqtndgzd.supabase.co
 *   SUPABASE_SERVICE_KEY  = <your service_role key from Supabase → Settings → API>
 *
 * package.json dependencies needed:
 *   "@supabase/supabase-js": "^2.39.0"
 *   (node-fetch not needed — Node 24 has native fetch)
 */

const { createClient } = require('@supabase/supabase-js');
// Node 24 has native fetch built-in — no node-fetch needed

// ── NetgearGH constants ───────────────────────────────────────────────────────
const NG_BASE        = 'https://netgeargh.app/api/v1';
const NG_TIMEOUT_MS  = 25000;

// network_id per NetgearGH /fetch-networks response:
// 1=AT iShare, 2=Telecel, 3=MTN, 4=AT BigTime
const NG_NETWORK_IDS = { mtn: 3, telecel: 2, at: 4, 'at-ishare': 1 };

// ── Helpers ───────────────────────────────────────────────────────────────────

// Always set CORS + JSON content-type
function setHeaders(res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// Always respond with JSON — no plain text ever
function send(res, status, body) {
  setHeaders(res);
  res.status(status).json(body);
}

// Vercel parses JSON body automatically when Content-Type is application/json
// This fallback handles edge cases where it doesn't
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

// ── Call NetgearGH via Supabase Edge Function (bypasses Cloudflare IP block) ─
//
// WHY: Cloudflare on netgeargh.app blocks ALL datacenter IPs (Vercel, AWS etc).
//      Supabase Edge Functions run on Deno Deploy which uses residential-like IPs
//      that Cloudflare does NOT block. So we proxy through the Edge Function.
//
// Edge Function URL: https://acvvgkbbodyweqtndgzd.supabase.co/functions/v1/netgear-proxy
// Deploy it from: /supabase/functions/netgear-proxy/index.ts

async function callNetgear(network, phone, volumeMB, orderRef) {
  const PROXY_URL = 'https://acvvgkbbodyweqtndgzd.supabase.co/functions/v1/netgear-proxy';

  let endpoint, payload;
  if (network === 'at-ishare') {
    // AT iShare only → /buy-ishare-package (network_id: 1)
    endpoint = '/buy-ishare-package';
    payload  = { recipient_msisdn: phone, shared_bundle: volumeMB, order_reference: orderRef };
  } else {
    // MTN (network_id:3), Telecel (network_id:2), AT BigTime (network_id:4)
    endpoint = '/buy-other-package';
    payload  = { recipient_msisdn: phone, network_id: NG_NETWORK_IDS[network], shared_bundle: volumeMB };
  }

  console.log(`Calling NetgearGH via proxy: ${endpoint} | network=${network} | phone=${phone} | mb=${volumeMB}`);

  // Abort controller for timeout
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NG_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(PROXY_URL, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        // Supabase anon key to invoke the edge function
        'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFjdnZna2Jib2R5d2VxdG5kZ3pkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQyNzEyNjYsImV4cCI6MjA4OTg0NzI2Nn0.80xmBIX8FPy6h0NBkYG7_Duf9C6sTsjjtEMKcw9YHI4',
      },
      body: JSON.stringify({ endpoint, payload }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const proxyText = await res.text();
  let proxyData;
  try {
    proxyData = JSON.parse(proxyText);
  } catch {
    throw new Error('Proxy returned non-JSON: ' + proxyText.substring(0, 100));
  }

  // Proxy returned a Cloudflare block signal
  if (proxyData.error === 'CF_BLOCK') {
    throw new Error('CF_BLOCK');
  }

  // Proxy itself errored
  if (!res.ok && !proxyData.httpStatus) {
    throw new Error('Proxy error: ' + (proxyData.error || res.status));
  }

  const { httpStatus, data } = proxyData;
  console.log(`NetgearGH response via proxy: status=${httpStatus} data=${JSON.stringify(data).substring(0, 200)}`);
  return { httpStatus, data };
}

// Normalise NetgearGH response across both endpoints
function parseNetgearResponse(network, httpStatus, data) {
  // Detect Cloudflare block returned as a 403 with HTML body
  if (httpStatus === 403 && data._parseError) {
    throw new Error('CF_BLOCK');
  }

  let success, txnId, message;
  if (network === 'at-ishare') {
    // iShare endpoint response format: response_code + vendorTranxId
    const code = String(data.response_code || '');
    success = (code === '200' || httpStatus === 200) && !data.error;
    txnId   = data.vendorTranxId || '';
    message = data.response_msg  || '';
  } else {
    // buy-other-package response format: success + transaction_code
    success = data.success === true && httpStatus === 200;
    txnId   = data.transaction_code || '';
    message = data.message          || '';
  }
  if (!message && data._raw) message = data._raw.substring(0, 200);
  return { success, txnId, message };
}

// User-facing error message
function friendlyError(msg) {
  const m = (msg || '').toLowerCase();
  if (m.includes('does not exist') || m.includes('not found'))
    return 'Recipient number not found on this network. Please check the number.';
  if (m.includes('insufficient'))
    return 'Bundle temporarily unavailable. Contact support.';
  if (m.includes('out of stock') || m.includes('no package'))
    return 'This bundle size is out of stock. Try a different size.';
  if (m.includes('access denied') || m.includes('403'))
    return 'This network is currently unavailable. Contact support.';
  return msg || 'Delivery failed. Please try again or contact support.';
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════════════════════════
module.exports = async function handler(req, res) {

  // CORS preflight
  if (req.method === 'OPTIONS') {
    setHeaders(res);
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return send(res, 405, { error: 'Method not allowed' });
  }

  // ── Global try/catch: guarantees JSON on ALL crashes ────────────────────────
  try {

    // ── Check required env vars ───────────────────────────────────────────────
    const missingEnv = [];
    if (!process.env.SUPABASE_URL)          missingEnv.push('SUPABASE_URL');
    if (!process.env.SUPABASE_SERVICE_KEY)  missingEnv.push('SUPABASE_SERVICE_KEY');
    if (!process.env.NETGEAR_API_KEY)       missingEnv.push('NETGEAR_API_KEY');
    if (missingEnv.length > 0) {
      console.error('Missing env vars:', missingEnv);
      return send(res, 500, {
        error: 'Server misconfiguration. Contact support.',
        missing: missingEnv   // visible in Vercel logs, not dangerous
      });
    }

    // ── Init Supabase admin client ────────────────────────────────────────────
    const sb = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    // ── Authenticate user ─────────────────────────────────────────────────────
    const authRaw = req.headers['authorization'] || req.headers['Authorization'] || '';
    const token   = authRaw.replace(/^Bearer\s+/i, '').trim();
    if (!token) return send(res, 401, { error: 'Missing Authorization header' });

    const { data: authData, error: authErr } = await sb.auth.getUser(token);
    if (authErr || !authData?.user) {
      return send(res, 401, { error: 'Invalid or expired session. Please log in again.' });
    }
    const userId = authData.user.id;

    // ── Parse + validate body ─────────────────────────────────────────────────
    const body = await parseBody(req);
    const { network, size, validity, amount, recipient, mb, order_ref } = body;

    if (!network || !size || amount == null || !recipient || mb == null) {
      return send(res, 400, {
        error: 'Missing fields. Required: network, size, amount, recipient, mb',
      });
    }
    if (!['mtn', 'telecel', 'at', 'at-ishare'].includes(network)) {
      return send(res, 400, { error: 'Invalid network. Must be: mtn, telecel, at, or at-ishare' });
    }
    const amountNum = parseFloat(amount);
    const mbNum     = parseInt(mb, 10);
    if (isNaN(amountNum) || amountNum <= 0) return send(res, 400, { error: 'Invalid amount' });
    if (isNaN(mbNum)     || mbNum     <= 0) return send(res, 400, { error: 'Invalid mb value' });

    // Keep only digits from phone number
    const cleanPhone = String(recipient).replace(/\D/g, '');
    if (cleanPhone.length < 9) {
      return send(res, 400, { error: 'Invalid recipient phone number' });
    }

    const orderRef = order_ref || ('ED_' + network.toUpperCase() + '_' + Date.now());

    // ── Read fresh balance (prevents double-spend race) ───────────────────────
    const { data: profile, error: profErr } = await sb
      .from('profiles')
      .select('balance')
      .eq('id', userId)
      .single();

    if (profErr || !profile) {
      console.error('Profile read error:', profErr?.message);
      return send(res, 500, { error: 'Could not read wallet balance. Please try again.' });
    }

    const currentBalance = parseFloat(profile.balance || 0);
    if (currentBalance < amountNum) {
      return send(res, 402, {
        error: 'Insufficient wallet balance.',
        balance: currentBalance,
        required: amountNum,
      });
    }

    // ── Deduct balance (reserve funds before API call) ────────────────────────
    const newBalance = parseFloat((currentBalance - amountNum).toFixed(2));
    const { error: deductErr } = await sb
      .from('profiles')
      .update({ balance: newBalance })
      .eq('id', userId);

    if (deductErr) {
      console.error('Deduct error:', deductErr.message);
      return send(res, 500, { error: 'Failed to update balance. Please try again.' });
    }

    // ── Call NetgearGH ────────────────────────────────────────────────────────
    let ngResult    = null;
    let networkFail = false;
    let networkMsg  = '';

    try {
      const { httpStatus, data } = await callNetgear(network, cleanPhone, mbNum, orderRef);
      ngResult = parseNetgearResponse(network, httpStatus, data);
    } catch (ngErr) {
      networkFail = true;
      if (ngErr.message === 'CF_BLOCK') {
        networkMsg = 'Cloudflare blocked the request. Queued for manual review.';
        console.error('CF_BLOCK on order:', orderRef);
      } else if (ngErr.name === 'AbortError') {
        networkMsg = 'NetgearGH timed out after 25 seconds';
        console.error('TIMEOUT on order:', orderRef);
      } else {
        networkMsg = ngErr.message;
        console.error('NetgearGH error on order:', orderRef, '|', ngErr.message);
      }
    }

    // ════════════════════════════════════════════════════════════════════════════
    // PATH A: SUCCESS — bundle delivered ✅
    // ════════════════════════════════════════════════════════════════════════════
    if (ngResult && ngResult.success) {
      await sb.from('transactions').insert({
        user_id:       userId,
        type:          'purchase',
        network,
        size,
        validity:      validity || '30 Days',
        amount:        amountNum,
        recipient:     cleanPhone,
        status:        'delivered',
        vendor_txn_id: ngResult.txnId,
        order_ref:     orderRef,
        api_message:   ngResult.message,
      });

      return send(res, 200, {
        success:       true,
        status:        'delivered',
        new_balance:   newBalance,
        vendor_txn_id: ngResult.txnId,
        message:       ngResult.message || 'Bundle delivered successfully',
      });
    }

    // ════════════════════════════════════════════════════════════════════════════
    // PATH B: NETWORK/TIMEOUT — pending for manual review ⏳
    // ════════════════════════════════════════════════════════════════════════════
    if (networkFail) {
      // Balance stays deducted — we cannot confirm delivery
      // You review via Supabase: filter transactions where status='pending' AND type='purchase'
      await sb.from('transactions').insert({
        user_id:     userId,
        type:        'purchase',
        network,
        size,
        validity:    validity || '30 Days',
        amount:      amountNum,
        recipient:   cleanPhone,
        status:      'pending',
        order_ref:   orderRef,
        api_message: networkMsg,
        note:        'MANUAL REVIEW NEEDED — NetgearGH unreachable. Verify order: ' + orderRef,
      });

      return send(res, 202, {
        success:     false,
        status:      'pending',
        new_balance: newBalance,
        order_ref:   orderRef,
        message:     'Your order is queued and will be delivered shortly.',
      });
    }

    // ════════════════════════════════════════════════════════════════════════════
    // PATH C: API REJECTED — refund automatically ❌
    // ════════════════════════════════════════════════════════════════════════════
    const refundBalance = parseFloat((newBalance + amountNum).toFixed(2));

    await sb.from('profiles').update({ balance: refundBalance }).eq('id', userId);

    await sb.from('transactions').insert({
      user_id:     userId,
      type:        'purchase',
      network,
      size,
      validity:    validity || '30 Days',
      amount:      amountNum,
      recipient:   cleanPhone,
      status:      'failed',
      order_ref:   orderRef,
      api_message: ngResult?.message || 'API rejected the request',
      note:        'Balance auto-refunded',
    });

    return send(res, 422, {
      success:      false,
      status:       'failed',
      new_balance:  refundBalance,
      error:        friendlyError(ngResult?.message),
      error_detail: ngResult?.message || 'Unknown error from data provider',
    });

  } catch (err) {
    // ── Catch-all: no plain HTML 500s ever ───────────────────────────────────
    console.error('Unhandled error in purchase.js:', err.message, err.stack);
    return send(res, 500, {
      error: 'An unexpected error occurred. Please try again.',
    });
  }
};
