// api/topup.js
const { createClient } = require('@supabase/supabase-js');

// 1. Corrected Variable Names to match Vercel settings
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY 
);

module.exports = async function handler(req, res) {
  // 2. Add CORS Headers (Prevents browser blocks)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // 3. Verify session token
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'No auth token' });

  try {
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: 'Invalid session' });

    const { user_id, amount, method, phone, reference } = req.body;

    if (user.id !== user_id) return res.status(403).json({ error: 'Unauthorized' });
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

    // 4. Get current balance
    const { data: profile, error: profileErr } = await supabaseAdmin
      .from('profiles')
      .select('balance')
      .eq('id', user_id)
      .single();

    if (profileErr) throw new Error('Could not fetch profile');

    const currentBalance = parseFloat(profile.balance || 0);
    const newBalance = parseFloat((currentBalance + amount).toFixed(2));

    // 5. Update balance in database
    const { error: updateErr } = await supabaseAdmin
      .from('profiles')
      .update({ balance: newBalance })
      .eq('id', user_id);

    if (updateErr) throw new Error('Balance update failed');

    // 6. Record transaction (Matches your SQL columns)
    await supabaseAdmin.from('transactions').insert({
      user_id,
      type: 'topup',
      method: method || 'Paystack',
      phone: phone || '',
      amount: amount,
      order_ref: reference || `PAY-${Date.now()}`, // Changed 'reference' to 'order_ref'
      status: 'success'
    });

    return res.status(200).json({ success: true, new_balance: newBalance });

  } catch (e) {
    console.error('Topup API error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
