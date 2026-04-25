/**
 * EasyData GH — /api/manual-topup.js
 * Records a pending manual MoMo transfer for admin review.
 * No balance is touched here — admin changes status in Supabase
 * and the polling system on the frontend detects the change.
 */
const { createClient } = require('@supabase/supabase-js');

function setHeaders(res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}
function send(res, status, body) { setHeaders(res); res.status(status).json(body); }

async function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise(resolve => {
    let raw = '';
    req.on('data', c => { raw += c.toString(); });
    req.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') { setHeaders(res); return res.status(200).end(); }
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
  try {
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY,
      { auth: { autoRefreshToken: false, persistSession: false } });
    const token = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
    if (!token) return send(res, 401, { error: 'Missing token' });
    const { data: auth, error: authErr } = await sb.auth.getUser(token);
    if (authErr || !auth?.user) return send(res, 401, { error: 'Invalid session' });
    const body = await parseBody(req);
    const { amount, reference } = body;
    if (!amount || amount < 5) return send(res, 400, { error: 'Minimum amount is GHS 5' });
    await sb.from('transactions').insert({
      user_id: auth.user.id,
      type: 'topup',
      method: 'Manual MTN MoMo',
      phone: '0536426562',
      amount: parseFloat(amount),
      reference: reference || ('MANUAL_' + Date.now()),
      status: 'pending',
      note: 'Awaiting admin verification'
    });
    return send(res, 200, { success: true, message: 'Order submitted for review' });
  } catch (err) {
    console.error('[manual-topup]', err.message);
    return send(res, 500, { error: 'Server error' });
  }
};
