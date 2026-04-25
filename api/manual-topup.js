/**
 * EasyData GH — /api/manual-topup.js
 * FIXED: Auth handling and Column Name Mapping
 */
const { createClient } = require('@supabase/supabase-js');

function setHeaders(res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function send(res, status, body) { setHeaders(res); res.status(status).json(body); }

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') { setHeaders(res); return res.status(200).end(); }
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });

  try {
    // 1. Initialize Supabase Admin (Bypasses RLS)
    const sb = createClient(
      process.env.SUPABASE_URL, 
      process.env.SUPABASE_SERVICE_KEY
    );

    // 2. Get the Token from Headers
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();

    if (!token) return send(res, 401, { error: 'Login required' });

    // 3. Verify User
    const { data: auth, error: authErr } = await sb.auth.getUser(token);
    
    // If Supabase rejects the token (403/401), we stop here
    if (authErr || !auth?.user) {
      console.error('Auth Error:', authErr?.message);
      return send(res, 401, { error: 'Session expired. Please log out and log back in.' });
    }

    const userId = auth.user.id;

    // 4. Parse Body
    const { amount, reference } = req.body;
    if (!amount || parseFloat(amount) < 5) {
      return send(res, 400, { error: 'Minimum amount is GHS 5' });
    }

    // 5. INSERT INTO DB
    // IMPORTANT: Changed 'reference' to 'order_ref' to match your SQL columns
    const { error: dbErr } = await sb.from('transactions').insert({
      user_id:   userId,
      type:      'topup',
      method:    'Manual MTN MoMo',
      phone:     '0536426562',
      amount:    parseFloat(amount),
      order_ref: reference || ('MAN_REQ_' + Date.now()), // Changed to order_ref
      status:    'pending',
      note:      'Awaiting admin verification'
    });

    if (dbErr) {
      console.error('Database Insert Error:', dbErr.message);
      return send(res, 500, { error: 'Could not log request. Try again.' });
    }

    return send(res, 200, { success: true, message: 'Top-up request logged successfully.' });

  } catch (err) {
    console.error('[manual-topup fatal]', err.message);
    return send(res, 500, { error: 'Internal server error' });
  }
};
