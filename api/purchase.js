/**
 * EasyData GH — /api/purchase.js
 * STATUS-HELD VERSION: Marks successful API calls as 'processing' for admin review.
 */

const { createClient } = require('@supabase/supabase-js');

const NG_BASE = 'https://netgeargh.app/api/v1';
const NG_NETWORK_IDS = { mtn: 3, telecel: 2, at: 4, 'at-ishare': 1 };

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
    const mbValue = parseInt(String(mb || size || "0").replace(/\D/g, ''), 10);
    const orderRef = order_ref || `ED-${Date.now()}`;

    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '').trim();
    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) return res.status(401).json({ error: "Session expired" });

    // 1. Balance Check
    const { data: profile } = await supabase.from('profiles').select('balance').eq('id', user.id).single();
    if (!profile || profile.balance < amount) return res.status(402).json({ error: "Insufficient balance" });

    // 2. Deduct Funds
    const newBal = parseFloat((profile.balance - amount).toFixed(2));
    await supabase.from('profiles').update({ balance: newBal }).eq('id', user.id);

    // 3. Construct Payload
    let endpoint = network === 'at-ishare' ? '/buy-ishare-package' : '/buy-other-package';
    let payload = { recipient_msisdn: String(recipient), shared_bundle: mbValue };
    if (network === 'at-ishare') payload.order_reference = String(orderRef);
    else payload.network_id = NG_NETWORK_IDS[network] || 3;

    try {
      const response = await fetch(NG_BASE + endpoint, {
        method: 'POST',
        headers: { 'x-api-key': process.env.NETGEAR_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const text = await response.text();
      let result = {};
      try { result = JSON.parse(text); } catch(e) { throw new Error("GATEWAY_ERROR"); }

      // 4. HANDLE SUCCESS -> Mark as 'processing' (Manual Handover)
      if (result.response_code === "200" || result.success === true) {
        await supabase.from('transactions').insert({
          user_id: user.id, type: 'purchase', network, size, amount, recipient, 
          status: 'processing', // <--- This triggers the orange badge
          vendor_txn_id: result.transaction_code || result.vendorTranxId, order_ref: orderRef
        });
        return res.status(200).json({ success: true, new_balance: newBal });
      }

      // 5. HANDLE REJECTION (User error) -> Auto Refund
      const refundBal = parseFloat((newBal + amount).toFixed(2));
      await supabase.from('profiles').update({ balance: refundBal }).eq('id', user.id);
      await supabase.from('transactions').insert({
        user_id: user.id, type: 'purchase', network, size, amount, recipient, status: 'failed', 
        api_message: result.message || "Provider Error", note: "Refunded"
      });
      return res.status(422).json({ error: (result.message || "Error") + ". Money refunded." });

    } catch (apiErr) {
      // 6. MANUAL FALLBACK (Lag) -> Mark as 'pending'
      await supabase.from('transactions').insert({
        user_id: user.id, type: 'purchase', network, size, amount, recipient, status: 'pending', 
        order_ref: orderRef, note: "API Error: " + apiErr.message
      });
      return res.status(200).json({ success: true, new_balance: newBal, message: "Manual delivery needed." });
    }
  } catch (err) {
    return res.status(500).json({ error: "Internal Error" });
  }
};
