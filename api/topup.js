// api/topup.js - fully ready for Paystack webhook
const { createClient } = require('@supabase/supabase-js');

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Immediately respond 200 to Paystack to avoid webhook timeout
  res.status(200).json({ received: true });

  try {
    // Extract data directly from webhook
    const { user_id, amount, method, phone, reference } = req.body;

    if (!user_id || !amount || amount <= 0) {
      console.error('Invalid top-up request:', req.body);
      return;
    }

    // Get current balance
    const { data: profile, error: profileErr } = await supabaseAdmin
      .from('profiles')
      .select('balance')
      .eq('id', user_id)
      .single();

    if (profileErr) {
      console.error('Could not fetch profile:', profileErr.message);
      return;
    }

    const currentBalance = parseFloat(profile.balance) || 0;
    const newBalance = parseFloat((currentBalance + amount).toFixed(2));

    // Update balance
    const { error: updateErr } = await supabaseAdmin
      .from('profiles')
      .update({ balance: newBalance })
      .eq('id', user_id);

    if (updateErr) console.error('Balance update failed:', updateErr.message);

    // Record transaction
    const { error: txErr } = await supabaseAdmin
      .from('transactions')
      .insert({
        user_id,
        type: 'topup',
        method: method || 'Mobile Money',
        phone: phone || '',
        amount,
        reference: reference || '',
        status: 'success'
      });

    if (txErr) console.error('Transaction insert failed:', txErr.message);

    console.log(`Top-up completed for user ${user_id}: +${amount}`);

  } catch (err) {
    console.error('Error processing top-up:', err.message);
  }
};
