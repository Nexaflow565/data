/**
 * EasyData GH — /api/purchase.js
 * CRASH-PROOF VERSION: Handles 502 Bad Gateway & Auto-Refunds
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
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    let body = req.body;
    if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch(e) { body = {}; }
    }

    const { network, size, amount, recipient, mb, order_ref } = body;
    const mbValue = parseInt(String(mb || size || "0").replace(/\D/g, ''), 10);

    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '').trim();
    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) return res.status(401).json({ error: "Session expired" });

    // 1. Balance Check
    const { data: profile } = await supabase.from('profiles').select('balance').eq('id', user.id).single();
    if (!profile || profile.balance < amount) return res.status(402).json({ error: "Insufficient balance" });

    // 2. Deduct immediately (Hold funds)
    const newBal = parseFloat((profile.balance - amount).toFixed(2));
    await supabase.from('profiles').update({ balance: newBal }).eq('id', user.id);

    const orderRef = order_ref || `ED-${network}-${Date.now()}`;

    // 3. Call Netgear
    const endpoint = network === 'at' ? '/buy-ishare-package' : '/buy-other-package';
    const providerBody = network === 'at' 
      ? { recipient_msisdn: recipient, shared_bundle: mbValue, order_reference: orderRef }
      : { recipient_msisdn: recipient, network_id: NG_NETWORK_IDS[network] || 3, shared_bundle: mbValue };

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

      // --- NEW: SAFE PARSING LOGIC ---
      const text = await response.text();
      let result = {};
      try {
        result = JSON.parse(text);
      } catch (e) {
        // If it's not JSON (like a 502 error), force a retry/fail state
        console.error("Netgear sent non-JSON response:", text.substring(0, 100));
        throw new Error("GATEWAY_ERROR"); 
      }

      if (result.response_code === "200" || result.success === true) {
        await supabase.from('transactions').insert({
          user_id: user.id, type: 'purchase', network, size, amount, recipient, status: 'delivered', 
          vendor_txn_id: result.vendorTranxId || result.transaction_code, order_ref: orderRef
        });
        return res.status(200).json({ success: true, new_balance: newBal });
      } else {
        // Refund if rejected by API logic (e.g. Invalid Number)
        const refundBal = parseFloat((newBal + amount).toFixed(2));
        await supabase.from('profiles').update({ balance: refundBal }).eq('id', user.id);
        await supabase.from('transactions').insert({
          user_id: user.id, type: 'purchase', network, size, amount, recipient, status: 'failed', 
          api_message: result.message || "Provider Declined"
        });
        return res.status(422).json({ error: result.message || "Money refunded." });
      }

    } catch (apiErr) {
      // --- AUTO-REFUND ON SERVER ERRORS (502, 500, Timeout) ---
      const refundBal = parseFloat((newBal + amount).toFixed(2));
      await supabase.from('profiles').update({ balance: refundBal }).eq('id', user.id);
      
      await supabase.from('transactions').insert({
        user_id: user.id, type: 'purchase', network, size, amount, recipient, status: 'failed', 
        note: "Auto-refunded due to Provider 502/Timeout"
      });

      return res.status(422).json({ 
        error: "Netgear server is temporarily down. Your money has been refunded to your wallet. Please try again in 10 minutes." 
      });
    }

  } catch (err) {
    return res.status(500).json({ error: "System Error" });
  }
};
