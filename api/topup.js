// api/topup.js
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL, 
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = async function handler(req, res) {
  // 1. Setup CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { user_id, amount, method, phone, reference } = req.body;

    // A. Fetch current balance
    const { data: profile, error: pErr } = await supabase
      .from('profiles')
      .select('balance')
      .eq('id', user_id)
      .single();

    if (pErr || !profile) {
       return res.status(404).json({ error: "User not found" });
    }

    const newBalance = parseFloat(((profile.balance || 0) + amount).toFixed(2));

    // B. Update Profile
    const { error: upErr } = await supabase
      .from('profiles')
      .update({ balance: newBalance })
      .eq('id', user_id);

    if (upErr) throw new Error("Balance update failed");

    // C. Log Transaction
    await supabase.from('transactions').insert({
      user_id,
      type: 'topup',
      amount,
      method: method || 'Paystack',
      phone: phone || '',
      order_ref: reference || `PAY-${Date.now()}`,
      status: 'success'
    });

    // D. CRITICAL: Send response and return to stop the function
    return res.status(200).json({ 
        success: true, 
        new_balance: newBalance 
    });

  } catch (err) {
    console.error("Topup Error:", err.message);
    // Ensure we send a response on error too so it doesn't hang
    return res.status(500).json({ error: err.message });
  }
};
