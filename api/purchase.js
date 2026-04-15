// api/purchase.js
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  // 1. Set Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // 2. Check for missing Environment Variables
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY || !process.env.NETGEAR_API_KEY) {
      console.error("CRITICAL: Missing environment variables in Vercel settings.");
      return res.status(500).json({ error: "Server configuration error" });
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // 3. Authenticate User
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '').trim();
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);

    if (authErr || !user) {
      return res.status(401).json({ error: "Session expired. Please login again." });
    }

    // 4. Validate Data
    const { network, size, amount, recipient, mb, order_ref } = req.body;
    
    // Convert MB to number safely (removes letters if any)
    const mbValue = parseInt(String(mb).replace(/\D/g, ''), 10);

    if (!network || !recipient || !mbValue) {
      return res.status(400).json({ error: "Missing purchase details" });
    }

    // 5. Check Balance
    const { data: profile } = await supabase.from('profiles').select('balance').eq('id', user.id).single();
    if (!profile || profile.balance < amount) {
      return res.status(402).json({ error: "Insufficient balance" });
    }

    // 6. CALL NETGEAR API
    const netIdMap = { mtn: 3, telecel: 2, at: 1 };
    const endpoint = network === 'at' 
      ? 'https://netgeargh.app/api/v1/buy-ishare-package' 
      : 'https://netgeargh.app/api/v1/buy-other-package';

    const providerBody = network === 'at' 
      ? { recipient_msisdn: recipient, shared_bundle: mbValue, order_reference: order_ref || `ED-${Date.now()}` }
      : { recipient_msisdn: recipient, network_id: netIdMap[network] || 3, shared_bundle: mbValue };

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'api-key': process.env.NETGEAR_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(providerBody)
    });

    const result = await response.json();

    // 7. Handle Result
    if (result.response_code === "200" || result.success === true) {
      const newBal = parseFloat((profile.balance - amount).toFixed(2));
      await supabase.from('profiles').update({ balance: newBal }).eq('id', user.id);
      await supabase.from('transactions').insert({
        user_id: user.id, type: 'purchase', network, size, amount, recipient, status: 'delivered'
      });
      return res.status(200).json({ success: true, new_balance: newBal });
    } else {
      return res.status(400).json({ error: result.message || "Provider declined request" });
    }

  } catch (err) {
    console.error("RUNTIME ERROR:", err.message);
    return res.status(500).json({ error: "Internal Server Error", details: err.message });
  }
};
