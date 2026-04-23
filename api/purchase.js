/**
 * EasyData GH — /api/purchase.js
 * ABSOLUTE STRICT VERSION (Based on Doc Page 5 & 6)
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

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch(e) { body = {}; } }

    const { network, size, amount, recipient, mb, order_ref } = body;
    
    // Ensure Clean Number (No decimals, no text)
    const mbValue = Math.floor(parseInt(String(mb || size || "0").replace(/\D/g, ''), 10));
    const orderRef = order_ref || `ED-${Date.now()}`;

    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '').trim();
    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) return res.status(401).json({ error: "Session expired" });

    // 1. Balance Logic
    const { data: profile } = await supabase.from('profiles').select('balance').eq('id', user.id).single();
    if (!profile || profile.balance < amount) return res.status(402).json({ error: "Insufficient balance" });

    const newBal = parseFloat((profile.balance - amount).toFixed(2));
    await supabase.from('profiles').update({ balance: newBal }).eq('id', user.id);

    // 2. CONSTRUCT REQUESTS (STRICTLY BY THE BOOK)
    let endpoint = '';
    let providerBody = {};

    if (network === 'at') {
      // AirtelTigo (Page 5): Needs msisdn, bundle, and reference
      endpoint = '/buy-ishare-package';
      providerBody = { 
          recipient_msisdn: String(recipient), 
          shared_bundle: mbValue, 
          order_reference: String(orderRef) 
      };
    } else {
      // MTN / Telecel (Page 6): Needs msisdn, network_id, and bundle (Reference NOT listed)
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
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(providerBody)
      });

      const text = await response.text();
      let result = {};
      try { result = JSON.parse(text); } catch(e) { throw new Error("Netgear Gateway Error (502)"); }

      if (result.response_code === "200" || result.success === true) {
        await supabase.from('transactions').insert({
          user_id: user.id, type: 'purchase', network, size, amount, recipient, status: 'delivered', 
          vendor_txn_id: result.transaction_code || result.vendorTranxId, order_ref: orderRef
        });
        return res.status(200).json({ success: true, new_balance: newBal });
      } 
      
      // Handle Rejection (Out of Stock, etc)
      const refundBal = parseFloat((newBal + amount).toFixed(2));
      await supabase.from('profiles').update({ balance: refundBal }).eq('id', user.id);
      await supabase.from('transactions').insert({
        user_id: user.id, type: 'purchase', network, size, amount, recipient, status: 'failed', 
        api_message: result.message || result.response_msg, note: "Auto-refunded"
      });
      return res.status(422).json({ error: (result.message || "Provider Error") + ". Money refunded." });

    } catch (apiErr) {
      // Log for Manual Bundle
      await supabase.from('transactions').insert({
        user_id: user.id, type: 'purchase', network, size, amount, recipient, status: 'pending', 
        order_ref: orderRef, note: "API ERROR: " + apiErr.message
      });
      return res.status(200).json({ success: true, new_balance: newBal, message: "Manual delivery needed." });
    }
  } catch (err) {
    return res.status(500).json({ error: "System Error" });
  }
};
