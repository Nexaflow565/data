/**
 * EasyData GH — /api/purchase.js
 * FULL PAYLOAD VERSION: 
 * - Sends 'order_reference' to ALL networks (ignores Page 6 of Doc to ensure stability)
 * - Keeps clean MB volume for 10GB/2GB packages
 * - Protects balance with Smart Logic
 */

const { createClient } = require('@supabase/supabase-js');

const NG_BASE = 'https://netgeargh.app/api/v1';
const NG_TIMEOUT_MS = 25000; 
const NG_NETWORK_IDS = { mtn: 3, telecel: 2, at: 1 };

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch(e) { body = {}; } }

    const { network, size, amount, recipient, mb, order_ref } = body;
    
    // Ensure 1GB becomes 1000, 10GB becomes 10000
    const mbValue = parseInt(String(mb || size || "0").replace(/\D/g, ''), 10);
    const orderRef = order_ref || `ED-${network.toUpperCase()}-${Date.now()}`;

    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '').trim();
    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) return res.status(401).json({ error: "Session expired" });

    // 1. Balance Check & Reservation
    const { data: profile } = await supabase.from('profiles').select('balance').eq('id', user.id).single();
    if (!profile || profile.balance < amount) return res.status(402).json({ error: "Insufficient balance" });

    const newBal = parseFloat((profile.balance - amount).toFixed(2));
    await supabase.from('profiles').update({ balance: newBal }).eq('id', user.id);

    // 2. CONSTRUCT REQUEST
    // We send order_reference to EVERYONE regardless of what Page 6 says.
    const endpoint = network === 'at' ? '/buy-ishare-package' : '/buy-other-package';
    const providerBody = { 
        recipient_msisdn: recipient, 
        shared_bundle: mbValue, 
        order_reference: orderRef 
    };

    // Add network_id only for MTN/Telecel
    if (network !== 'at') {
        providerBody.network_id = NG_NETWORK_IDS[network] || 3;
    }

    try {
      const response = await fetch(NG_BASE + endpoint, {
        method: 'POST',
        headers: {
          'x-api-key': process.env.NETGEAR_API_KEY,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0'
        },
        body: JSON.stringify(providerBody)
      });

      const text = await response.text();
      let result = {};
      try { result = JSON.parse(text); } catch(e) { throw new Error("GATEWAY_502_OR_HTML"); }

      // 3. HANDLE SUCCESS
      if (result.response_code === "200" || result.success === true) {
        await supabase.from('transactions').insert({
          user_id: user.id, type: 'purchase', network, size, amount, recipient, status: 'delivered', 
          vendor_txn_id: result.vendorTranxId || result.transaction_code, order_ref: orderRef
        });
        return res.status(200).json({ success: true, new_balance: newBal });
      } 
      
      // 4. HANDLE REJECTIONS (Refund)
      const refundBal = parseFloat((newBal + amount).toFixed(2));
      await supabase.from('profiles').update({ balance: refundBal }).eq('id', user.id);
      await supabase.from('transactions').insert({
        user_id: user.id, type: 'purchase', network, size, amount, recipient, status: 'failed', 
        api_message: result.message || result.response_msg, note: "Auto-refunded"
      });
      return res.status(422).json({ error: (result.message || "Package unavailable") + ". Refunded." });

    } catch (apiErr) {
      // 5. MANUAL FALLBACK (Lag)
      await supabase.from('transactions').insert({
        user_id: user.id, type: 'purchase', network, size, amount, recipient, status: 'pending', 
        order_ref: orderRef, note: "MANUAL BUNDLE: " + apiErr.message
      });
      return res.status(200).json({ success: true, new_balance: newBal, message: "Manual delivery needed." });
    }
  } catch (err) {
    return res.status(500).json({ error: "Internal Error" });
  }
};
