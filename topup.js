// api/topup.js
// Runs on Vercel serverless - service role key stays here, never in frontend
const { createClient } = require('@supabase/supabase-js');

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY  // secret - only in Vercel env vars
);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Verify session token
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'No auth token' });

  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Invalid or expired session' });

  const { user_id, amount, method, phone, reference } = req.body;

  // Security: user can only top up their own account
  if (user.id !== user_id) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  if (!amount || amount <= 0) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  try {
    // 1. Get current balance
    const { data: profile, error: profileErr } = await supabaseAdmin
      .from('profiles')
      .select('balance')
      .eq('id', user_id)
      .single();

    if (profileErr) throw new Error('Could not fetch profile: ' + profileErr.message);

    const currentBalance = parseFloat(profile.balance) || 0;
    const newBalance = parseFloat((currentBalance + amount).toFixed(2));

    // 2. Update balance
    const { error: updateErr } = await supabaseAdmin
      .from('profiles')
      .update({ balance: newBalance })
      .eq('id', user_id);

    if (updateErr) throw new Error('Balance update failed: ' + updateErr.message);

    // 3. Record transaction
    const { error: txErr } = await supabaseAdmin
      .from('transactions')
      .insert({
        user_id,
        type:      'topup',
        method:    method || 'Mobile Money',
        phone:     phone || '',
        amount,
        reference: reference || '',
        status:    'success'
      });

    if (txErr) {
      console.error('TX insert failed after balance credit:', txErr.message);
    }

    return res.status(200).json({ success: true, new_balance: newBalance });

  } catch (e) {
    console.error('Topup API error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
