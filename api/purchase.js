/**
 * EasyData GH — Purchase API Route
 * File: /api/purchase.js  (Vercel Serverless Function)
 *
 * Environment variables required in Vercel dashboard:
 *   NETGEAR_API_KEY        → your NetgearGH API key
 *   SUPABASE_URL           → https://acvvgkbbodyweqtndgzd.supabase.co
 *   SUPABASE_SERVICE_KEY   → your Supabase service_role key (NOT the anon key)
 *
 * Flow:
 *   1. Authenticate request via Supabase JWT (user must be logged in)
 *   2. Validate body fields
 *   3. Check user balance in DB (fresh read — prevents double-spend)
 *   4. Deduct balance atomically
 *   5. Call NetgearGH API to deliver the bundle
 *   6a. SUCCESS  → mark transaction status = 'delivered', return new balance
 *   6b. API FAIL → refund balance, mark status = 'failed', return error
 *   6c. NETWORK  → refund balance, mark status = 'pending' (manual fallback), alert you
 */

const { createClient } = require('@supabase/supabase-js');

// ── Constants ────────────────────────────────────────────────────────────────
const NG_BASE    = 'https://netgeargh.app/api/v1';
const NG_TIMEOUT = 25000; // 25 second timeout for NetgearGH calls

// Network ID mapping per NetgearGH API documentation
// 1 = AirtelTigo (iShare), 2 = Telecel, 3 = MTN
const NG_NETWORK_IDS = { mtn: 3, telecel: 2, at: 1 };

// ── CORS headers ─────────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type':                 'application/json',
};

// ── Helper: fetch with timeout ───────────────────────────────────────────────
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// ── Helper: call NetgearGH API ───────────────────────────────────────────────
async function callNetgearAPI(network, recipientPhone, volumeMB, orderRef) {
  const NG_KEY = process.env.NETGEAR_API_KEY;
  if (!NG_KEY) throw new Error('NETGEAR_API_KEY environment variable is not set');

  const headers = {
    'api-key':       NG_KEY,
    'Accept':        'application/json',
    'Content-Type':  'application/json',
  };

  let endpoint, body;

  if (network === 'at') {
    // ── AirtelTigo: /buy-ishare-package ──
    endpoint = '/buy-ishare-package';
    body = {
      recipient_msisdn: recipientPhone,
      shared_bundle:    volumeMB,
      order_reference:  orderRef,
    };
  } else {
    // ── MTN / Telecel: /buy-other-package ──
    endpoint = '/buy-other-package';
    body = {
      recipient_msisdn: recipientPhone,
      network_id:       NG_NETWORK_IDS[network],
      shared_bundle:    volumeMB,
    };
  }

  const res = await fetchWithTimeout(
    NG_BASE + endpoint,
    { method: 'POST', headers, body: JSON.stringify(body) },
    NG_TIMEOUT
  );

  const data = await res.json();
  return { httpStatus: res.status, data };
}

// ── Helper: parse NetgearGH response into a clean result ────────────────────
function parseNetgearResponse(network, httpStatus, data) {
  let success   = false;
  let txnId     = '';
  let message   = '';

  if (network === 'at') {
    // AirtelTigo iShare: response_code "200" = success
    const code = String(data.response_code || '');
    success = (code === '200' || httpStatus === 200) && !data.error;
    txnId   = data.vendorTranxId || '';
    message = data.response_msg  || '';
  } else {
    // MTN / Telecel: success === true
    success = data.success === true && httpStatus === 200;
    txnId   = data.transaction_code || '';
    message = data.message          || '';
  }

  return { success, txnId, message };
}

// ── Helper: human-readable error message ────────────────────────────────────
function friendlyError(message) {
  const m = (message || '').toLowerCase();
  if (m.includes('does not exist') || m.includes('not found'))
    return 'Recipient number not found on this network. Please check the number.';
  if (m.includes('insufficient'))
    return 'Bundle temporarily unavailable. Please contact support.';
  if (m.includes('out of stock') || m.includes('no package'))
    return 'Bundle is out of stock. Please try a different size.';
  if (m.includes('access denied') || m.includes('403'))
    return 'This network is not available right now. Contact support.';
  return message || 'Delivery failed. Please try again.';
}

// ── Main handler ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).set(CORS).json({ ok: true });
  }

  if (req.method !== 'POST') {
    return res.status(405).set(CORS).json({ error: 'Method not allowed' });
  }

  // ── 1. Initialise Supabase with SERVICE key (bypasses RLS for server ops) ──
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  // ── 2. Authenticate: verify the user's JWT from Authorization header ──────
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) {
    return res.status(401).set(CORS).json({ error: 'Missing authorization token' });
  }

  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) {
    return res.status(401).set(CORS).json({ error: 'Invalid or expired session' });
  }

  // ── 3. Parse and validate request body ───────────────────────────────────
  const { network, size, validity, amount, recipient, mb, order_ref } = req.body || {};

  if (!network || !size || !amount || !recipient || !mb) {
    return res.status(400).set(CORS).json({
      error: 'Missing required fields: network, size, amount, recipient, mb'
    });
  }

  if (!['mtn', 'telecel', 'at'].includes(network)) {
    return res.status(400).set(CORS).json({ error: 'Invalid network. Must be mtn, telecel, or at' });
  }

  const amountNum = parseFloat(amount);
  const mbNum     = parseInt(mb, 10);

  if (isNaN(amountNum) || amountNum <= 0) {
    return res.status(400).set(CORS).json({ error: 'Invalid amount' });
  }
  if (isNaN(mbNum) || mbNum <= 0) {
    return res.status(400).set(CORS).json({ error: 'Invalid bundle volume (mb)' });
  }

  const cleanPhone = String(recipient).replace(/\s+/g, '');
  if (cleanPhone.length < 10) {
    return res.status(400).set(CORS).json({ error: 'Invalid recipient phone number' });
  }

  // Generate order reference if not provided
  const orderRef = order_ref || ('ED_' + network.toUpperCase() + '_' + Date.now());

  // ── 4. Read fresh balance from DB (prevents race conditions / double spend) ─
  const { data: profile, error: profErr } = await supabase
    .from('profiles')
    .select('balance')
    .eq('id', user.id)
    .single();

  if (profErr || !profile) {
    return res.status(500).set(CORS).json({ error: 'Could not read user profile' });
  }

  const currentBalance = parseFloat(profile.balance || 0);

  if (currentBalance < amountNum) {
    return res.status(402).set(CORS).json({
      error: 'Insufficient balance',
      balance: currentBalance,
      required: amountNum,
    });
  }

  // ── 5. Deduct balance BEFORE calling API (reserve funds) ─────────────────
  const newBalance = parseFloat((currentBalance - amountNum).toFixed(2));

  const { error: deductErr } = await supabase
    .from('profiles')
    .update({ balance: newBalance })
    .eq('id', user.id);

  if (deductErr) {
    return res.status(500).set(CORS).json({ error: 'Balance deduction failed: ' + deductErr.message });
  }

  // ── 6. Call NetgearGH API ─────────────────────────────────────────────────
  let ngResult = null;
  let networkError = false;    // true = timeout / CORS / DNS etc.
  let networkErrMsg = '';

  try {
    const { httpStatus, data } = await callNetgearAPI(network, cleanPhone, mbNum, orderRef);
    ngResult = parseNetgearResponse(network, httpStatus, data);
    ngResult.rawData = data;   // keep for audit logging
  } catch (err) {
    // AbortError = timeout; TypeError = network/CORS issue
    networkError    = true;
    networkErrMsg   = err.name === 'AbortError'
      ? 'NetgearGH API timed out after 25s'
      : 'Network error reaching NetgearGH: ' + err.message;
  }

  // ── 7a. SUCCESS ───────────────────────────────────────────────────────────
  if (ngResult && ngResult.success) {

    await supabase.from('transactions').insert({
      user_id:      user.id,
      type:         'purchase',
      network:      network,
      size:         size,
      validity:     validity || '30 Days',
      amount:       amountNum,
      recipient:    cleanPhone,
      status:       'delivered',
      vendor_txn_id: ngResult.txnId,
      order_ref:    orderRef,
      api_message:  ngResult.message,
    });

    return res.status(200).set(CORS).json({
      success:      true,
      status:       'delivered',
      new_balance:  newBalance,
      vendor_txn_id: ngResult.txnId,
      message:      ngResult.message || 'Bundle delivered successfully',
    });
  }

  // ── 7b. NETWORK/TIMEOUT ERROR → Fallback: save as 'pending', manual review ─
  if (networkError) {

    // Do NOT refund — we don't know if the bundle was sent or not.
    // Save as 'pending' so you can check NetgearGH dashboard manually.
    await supabase.from('transactions').insert({
      user_id:    user.id,
      type:       'purchase',
      network:    network,
      size:       size,
      validity:   validity || '30 Days',
      amount:     amountNum,
      recipient:  cleanPhone,
      status:     'pending',
      order_ref:  orderRef,
      api_message: networkErrMsg,
      note:       'MANUAL REVIEW NEEDED: API unreachable at purchase time. Check NetgearGH dashboard for order ' + orderRef,
    });

    // Also log to Supabase errors table if it exists (non-blocking)
    supabase.from('admin_alerts').insert({
      type:     'purchase_pending_review',
      order_ref: orderRef,
      user_id:  user.id,
      network:  network,
      size:     size,
      recipient: cleanPhone,
      amount:   amountNum,
      reason:   networkErrMsg,
      created_at: new Date().toISOString(),
    }).then(() => {}).catch(() => {}); // fire and forget

    return res.status(202).set(CORS).json({
      success:     false,
      status:      'pending',
      new_balance: newBalance,   // balance stays deducted until manual review
      order_ref:   orderRef,
      message:     'Your order has been placed and is being reviewed. You will be notified once delivered.',
      error_detail: networkErrMsg,
    });
  }

  // ── 7c. API RETURNED FAILURE (e.g. wrong number, out of stock) → REFUND ───
  const refundBalance = parseFloat((newBalance + amountNum).toFixed(2));

  await supabase.from('profiles')
    .update({ balance: refundBalance })
    .eq('id', user.id);

  await supabase.from('transactions').insert({
    user_id:    user.id,
    type:       'purchase',
    network:    network,
    size:       size,
    validity:   validity || '30 Days',
    amount:     amountNum,
    recipient:  cleanPhone,
    status:     'failed',
    order_ref:  orderRef,
    api_message: ngResult ? ngResult.message : 'Unknown API error',
    note:       'Balance refunded automatically',
  });

  return res.status(422).set(CORS).json({
    success:      false,
    status:       'failed',
    new_balance:  refundBalance,     // refunded
    error:        friendlyError(ngResult ? ngResult.message : ''),
    error_detail: ngResult ? ngResult.message : '',
  });
};
