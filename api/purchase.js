// api/purchase.js
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  // ... (Headers and Auth same as before)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '').trim();
    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) return res.status(401).json({ error: "Unauthorized" });

    const { network, size, amount, recipient, mb, order_ref } = req.body;
    const mbValue = parseInt(String(mb).replace(/\D/g, ''), 10);

    // 1. FRESH BALANCE CHECK
    const { data: profile } = await supabase.from('profiles').select('balance').eq('id', user.id).single();
    if (!profile || profile.balance < amount) return res.status(402).json({ error: "Insufficient balance" });

    // 2. DEDUCT MONEY IMMEDIATELY (Hold it)
    const newBal = parseFloat((profile.balance - amount).toFixed(2));
    await supabase.from('profiles').update({ balance: newBal }).eq('id', user.id);

    // 3. CALL NETGEAR API
    const netIdMap = { mtn: 3, telecel: 2, at: 1 };
    const endpoint = network === 'at' ? 'https://netgeargh.app/api/v1/buy-ishare-package' : 'https://netgeargh.app/api/v1/buy-other-package';

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 
          'x-api-key': process.env.NETGEAR_API_KEY, 
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0' // Help bypass Cloudflare
        },
        body: JSON.stringify({
          recipient_msisdn: recipient,
          network_id: netIdMap[network] || 3,
          shared_bundle: mbValue,
          order_reference: order_ref || `ED-${Date.now()}`
        })
      });

      const result = await response.json();

      // CASE A: SUCCESS
      if (result.response_code === "200" || result.success === true) {
        await supabase.from('transactions').insert({
          user_id: user.id, type: 'purchase', network, size, amount, recipient, status: 'delivered', vendor_txn_id: result.vendorTranxId || result.transaction_code
        });
        return res.status(200).json({ success: true, new_balance: newBal, message: "Delivered" });
      } 
      
      // CASE B: USER ERROR (Wrong Number / Out of Stock) -> ONLY REFUND HERE
      const errorMsg = (result.message || result.response_msg || "").toLowerCase();
      if (errorMsg.includes("exist") || errorMsg.includes("invalid") || errorMsg.includes("stock")) {
         const refundBal = parseFloat((newBal + amount).toFixed(2));
         await supabase.from('profiles').update({ balance: refundBal }).eq('id', user.id);
         await supabase.from('transactions').insert({
           user_id: user.id, type: 'purchase', network, size, amount, recipient, status: 'failed', note: "Auto-refunded: " + errorMsg
         });
         return res.status(422).json({ error: "Invalid details. Money refunded.", new_balance: refundBal });
      }

      // CASE C: SERVER ERROR (403, Inactive Key, Maintenance) -> KEEP THE MONEY, MARK PENDING
      throw new Error("Provider Maintenance");

    } catch (apiErr) {
      // API FAILED OR BLOCKED -> Balance stays deducted!
      await supabase.from('transactions').insert({
        user_id: user.id, type: 'purchase', network, size, amount, recipient, status: 'pending', 
        note: "MANUAL BUNDLE REQUIRED (API Down/Blocked)"
      });
      return res.status(200).json({ 
        success: true, 
        new_balance: newBal, 
        message: "Order received and is being processed manually." 
      });
    }

  } catch (err) {
    return res.status(500).json({ error: "System Error" });
  }
};
