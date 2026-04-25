/**
 * EasyData GH — /api/topup.js
 * FEE-AWARE VERSION: Credits user only with the Net Amount after Paystack fees.
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
    
    if (authErr || !authData?.user) return send(res, 401, { error: 'Session expired' });
    const userId = authData.user.id;

    const { reference, amount: amountFromSite } = req.body;

    // 2. Prevent Double Credit (Idempotency)
    const { data: existing } = await supabase
      .from('transactions')
      .select('id')
      .eq('order_ref', reference)
      .eq('status', 'success')
      .maybeSingle();

    if (existing) {
      const { data: p } = await supabase.from('profiles').select('balance').eq('id', userId).single();
      return send(res, 200, { success: true, new_balance: p.balance, message: 'Already credited' });
    }

    // 3. VERIFY WITH PAYSTACK
    const PAYSTACK_KEY = process.env.PAYSTACK_SECRET_KEY;
    const verifyRes = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: { Authorization: `Bearer ${PAYSTACK_KEY}` }
    });
    const verifyData = await verifyRes.json();

    if (!verifyData.status || verifyData.data?.status !== 'success') {
      return send(res, 402, { error: 'Payment not successful on Paystack' });
    }

    // 4. CALCULATE NET AMOUNT (Subtracting Charges)
    // Paystack returns amounts and fees in Pesewas (divide by 100)
    const grossAmount = verifyData.data.amount / 100; // What the user paid
    const paystackFee = (verifyData.data.fees || 0) / 100; // Paystack's charge
    const netAmount = parseFloat((grossAmount - paystackFee).toFixed(2)); // Actual money you keep

    // 5. SECURITY CHECK
    // Ensure the gross amount paid matches what the site expected (0.50 margin)
    if (Math.abs(grossAmount - parseFloat(amountFromSite)) > 0.50) {
       return send(res, 402, { error: 'Payment amount mismatch. Fraud detected.' });
    }

    // 6. UPDATE WALLET WITH NET AMOUNT
    const { data: profile } = await supabase.from('profiles').select('balance').eq('id', userId).single();
    const newBalance = parseFloat(((profile.balance || 0) + netAmount).toFixed(2));

    await supabase.from('profiles').update({ balance: newBalance }).eq('id', userId);

    // 7. RECORD TRANSACTION
    await supabase.from('transactions').insert({
      user_id:   userId,
      type:      'topup',
      method:    'Paystack',
      amount:    netAmount,      // We record the net amount credited
      order_ref: reference,
      status:    'success',
      note:      `Gross: ${grossAmount}, Fee: ${paystackFee}` // Keep a note of the fees
    });

    return send(res, 200, { 
        success: true, 
        new_balance: newBalance,
        credited: netAmount,
        fee_deducted: paystackFee
    });

  } catch (err) {
    console.error('[topup fatal]', err.message);
    return send(res, 500, { error: 'Internal system error' });
  }
};
