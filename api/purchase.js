/**
 * EasyData GH — /api/purchase.js
 * PERMANENT FINAL VERSION
 * - Fixed 502 errors (Strict Page 5 & 6 mapping)
 * - Fixed 404 errors (Smart MB Multiplier for all sizes)
 * - Owner Protection (Deduct before call)
 */

const { createClient } = require('@supabase/supabase-js');

const NG_BASE = 'https://netgeargh.app/api/v1';
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
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch(e) { body = {}; } }

    const { network, size, amount, recipient, mb, order_ref } = body;
    
    // --- SMART MB MULTIPLIER (Handles all sizes) ---
    let mbValue = parseInt(String(mb || size || "0").replace(/\D/g, ''), 10);
    // If it's 1-499, it's definitely GB, so convert to MB (e.g. 10 -> 10000)
    // If it's 500+, it's already in MB, so leave it alone.
    if (mbValue > 0 && mbValue < 500) {
        mbValue = mbValue * 1000;
    }

    const orderRef = order_ref || `ED-${Date.now()}`;

    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '').trim();
    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) return res.status(401).json({ error: "Session expired" });

    // 1. Balance Check & Reservation
    const { data: profile } = await supabase.from('profiles').select('balance').eq('id', user.id).single();
    if (!profile || profile.balance < amount) return res.status(402).json({ error: "Insufficient balance" });

    const newBal = parseFloat((profile.balance - amount).toFixed(2));
    await supabase.from('profiles').update({ balance: newBal }).eq('id', user.id);

    // 2. CONSTRUCT REQUESTS (Page 5 & 6 Strict Mapping)
    let endpoint = '';
    let providerBody = {};

    if (network === 'at') {
      endpoint = '/buy-ishare-package';
      providerBody = { 
          recipient_msisdn: String(recipient), 
          shared_bundle: mbValue, 
          order_reference: String(orderRef) 
      };
    } else {
      endpoint = '/buy-other-package';
      providerBody = { 
          recipient_msisdn: String(recipient), 
          network_id: NG_NETWORK_IDS[network] || 3, 
          shared_bundle: mbValue 
      };
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
      try { result = JSON.parse(text); } catch(e) { throw new Error("API_GATEWAY_ERROR"); }

      // 3. HANDLE SUCCESS
      if (result.response_code === "200" || result.success === true) {
        await supabase.from('transactions').insert({
          user_id: user.id, type: 'purchase', network, size, amount, recipient, status: 'delivered', 
          vendor_txn_id: result.transaction_code || result.vendorTranxId, order_ref: orderRef
        });
        return res.status(200).json({ success: true, new_balance: newBal });
      } 
      
      // 4. HANDLE REJECTION (Auto-Refund)
      const refundBal = parseFloat((newBal + amount).toFixed(2));
      await supabase.from('profiles').update({ balance: refundBal }).eq('id', user.id);
      await supabase.from('transactions').insert({
        user_id: user.id, type: 'purchase', network, size, amount, recipient, status: 'failed', 
        api_message: result.message || result.response_msg, note: "Auto-refunded"
      });
      return res.status(422).json({ error: (result.message || "Package unavailable") + ". Money refunded." });

    } catch (apiErr) {
      // 5. MANUAL FALLBACK (Lag)
      await supabase.from('transactions').insert({
        user_id: user.id, type: 'purchase', network, size, amount, recipient, status: 'pending', 
        order_ref: orderRef, note: "MANUAL: " + apiErr.message
      });
      return res.status(200).json({ success: true, new_balance: newBal, message: "Network delay. Delivering manually." });
    }
  } catch (err) {
    return res.status(500).json({ error: "Internal Error" });
  }
};
