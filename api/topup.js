/**
 * EasyData GH — /api/topup.js
 * FIXED VERSION: Synchronized with Supabase SQL Columns
 */

const { createClient } = require('@supabase/supabase-js');

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

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') { setHeaders(res); return res.status(200).end(); }
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // 1. Authenticate user
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    const { data: authData, error: authErr } = await supabase.auth.getUser(token);
    
    if (authErr || !authData?.user) return send(res, 401, { error: 'Session expired. Login again.' });
    const userId = authData.user.id;

    const { amount, reference, method, phone } = req.body;
    const amountSentFromSite = parseFloat(amount);

    // 2. IDEMPOTENCY: Check if already credited (USING CORRECT COLUMN NAME: order_ref)
    const { data: existing } = await supabase
      .from('transactions')
      .select('id')
      .eq('order_ref', reference) // Use order_ref, not reference
      .eq('status', 'success')
      .maybeSingle();

    if (existing) {
      const { data: p } = await supabase.from('profiles').select('balance').eq('id', userId).single();
      return send(res, 200, { success: true, new_balance: p.balance, message: 'Already credited' });
    }

    // 3. VERIFY WITH PAYSTACK
    const PAYSTACK_KEY = process.env.PAYSTACK_SECRET_KEY;
    if (!PAYSTACK_KEY) return send(res, 500, { error: 'Payment gateway key missing' });

    const verifyRes = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: { Authorization: `Bearer ${PAYSTACK_KEY}` }
    });
    const verifyData = await verifyRes.json();

    if (!verifyData.status || verifyData.data?.status !== 'success') {
      console.error(`[topup] Paystack says NOT success:`, verifyData.data?.status);
      return send(res, 402, { error: 'Payment not successful on Paystack' });
    }

    const actualPaidAmount = verifyData.data.amount / 100;

    // 4. CHECK AMOUNT (With 0.10 margin for rounding errors)
    if (Math.abs(actualPaidAmount - amountSentFromSite) > 0.10) {
      console.error(`[topup] Amount mismatch. Site: ${amountSentFromSite}, PS: ${actualPaidAmount}`);
      return send(res, 402, { error: 'Payment amount mismatch. Contact support.' });
    }

    // 5. UPDATE BALANCE (The "Atomical" update)
    const { data: profile } = await supabase.from('profiles').select('balance').eq('id', userId).single();
    const newBalance = parseFloat(((profile.balance || 0) + actualPaidAmount).toFixed(2));

    await supabase.from('profiles').update({ balance: newBalance }).eq('id', userId);

    // 6. RECORD TRANSACTION (USING CORRECT COLUMN NAME: order_ref)
    await supabase.from('transactions').insert({
      user_id:   userId,
      type:      'topup',
      method:    method || 'Paystack',
      phone:     phone || '',
      amount:    actualPaidAmount,
      order_ref: reference, // Matches SQL Column
      status:    'success'
    });

    return send(res, 200, { success: true, new_balance: newBalance });

  } catch (err) {
    console.error('[topup fatal]', err.message);
    return send(res, 500, { error: 'Internal system error' });
  }
};
