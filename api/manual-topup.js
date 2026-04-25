/**
 * EasyData GH — /api/manual-topup.js
 * FINAL ROBUST VERSION
 */
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Get the Token
    const authHeader = req.headers.authorization || req.headers.Authorization || '';
    // Use a simpler replace to ensure no characters are missed
    const token = authHeader.split(' ')[1]; 

    if (!token) {
        return res.status(401).json({ error: "No login token found. Please log in again." });
    }

    // Verify User with Supabase
    const { data: auth, error: authErr } = await supabase.auth.getUser(token);
    
    if (authErr || !auth?.user) {
      console.error('Supabase Auth Rejection:', authErr?.message);
      return res.status(401).json({ error: "Session expired. Please Log Out and Log In again." });
    }

    const { amount, reference } = req.body;
    if (!amount || parseFloat(amount) < 5) {
      return res.status(400).json({ error: 'Minimum amount is GHS 5' });
    }

    // Insert into DB using 'order_ref' column
    const { error: dbErr } = await supabase.from('transactions').insert({
      user_id:   auth.user.id,
      type:      'topup',
      method:    'Manual MTN MoMo',
      phone:     '0536426562',
      amount:    parseFloat(amount),
      order_ref: reference || ('MAN_REQ_' + Date.now()),
      status:    'pending',
      note:      'Awaiting admin verification'
    });

    if (dbErr) {
      console.error('DB Error:', dbErr.message);
      return res.status(500).json({ error: 'Database update failed.' });
    }

    return res.status(200).json({ success: true, message: 'Request submitted!' });

  } catch (err) {
    return res.status(500).json({ error: "Internal server error" });
  }
};
