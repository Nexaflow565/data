/**
 * EasyData GH — /api/purchase.js
 * SMART LOGIC VERSION: 
 * - Auto-Refunds on User Errors (Wrong Number)
 * - Captures & Holds money on Server Errors (502/HTML) for Manual Bundling
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
    if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch(e) { body = {}; }
    }

    const { network, size, amount, recipient, mb, order_ref } = body;
    const mbValue = parseInt(String(mb || size || "0").replace(/\D/g, ''), 10);
    const orderRef = order_ref || `ED-${network}-${Date.now()}`;

    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '').trim();
    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) return res.status(401).json({ error: "Session expired" });

    // 1. Balance Check
    const { data: profile } = await supabase.from('profiles').select('balance').eq('id', user.id).single();
    if (!profile || profile.balance < amount) return res.status(402).json({ error: "Insufficient balance" });

    // 2. DEDUCT IMMEDIATELY (Hold the money)
    const newBal = parseFloat((profile.balance - amount).toFixed(2));
    await supabase.from('profiles').update({ balance: newBal }).eq('id', user.id);

    // 3. CALL NETGEAR
    const endpoint = network === 'at' ? '/buy-ishare-package' : '/buy-other-package';
    const providerBody = { 
        recipient_msisdn: recipient, 
        network_id: NG_NETWORK_IDS[network] || 3, 
        shared_bundle: mbValue, 
        order_reference: orderRef 
    };

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
      
      // CHECK IF RESPONSE IS HTML (Cloudflare 502/Maintenance)
      if (text.includes('<!DOCTYPE html>') || text.includes('Just a moment')) {
          throw new Error("PROVIDER_OFFLINE"); // Jump to catch block (Manual Fallback)
      }

      let result = {};
      try { result = JSON.parse(text); } catch(e) { throw new Error("INVALID_JSON"); }

      // --- CASE A: SUCCESS ---
      if (result.response_code === "200" || result.success === true) {
        await supabase.from('transactions').insert({
          user_id: user.id, type: 'purchase', network, size, amount, recipient, status: 'delivered', 
          vendor_txn_id: result.vendorTranxId || result.transaction_code, order_ref: orderRef
        });
        return res.status(200).json({ success: true, new_balance: newBal });
      } 
      
      // --- CASE B: USER ERROR (Wrong Number/Out of Stock) -> REFUND ---
      const msg = (result.message || result.response_msg || "").toLowerCase();
      if (msg.includes("exist") || msg.includes("invalid") || msg.includes("stock") || msg.includes("limit")) {
        const refundBal = parseFloat((newBal + amount).toFixed(2));
        await supabase.from('profiles').update({ balance: refundBal }).eq('id', user.id);
        await supabase.from('transactions').insert({
          user_id: user.id, type: 'purchase', network, size, amount, recipient, status: 'failed', 
          api_message: result.message || result.response_msg, note: "Auto-refunded"
        });
        return res.status(422).json({ error: (result.message || "Invalid details") + ". Money refunded." });
      }

      // --- CASE C: UNKNOWN REJECTION -> HOLD MONEY, MARK PENDING ---
      throw new Error(result.message || "Unknown Rejection");

    } catch (apiErr) {
      // --- MANUAL FALLBACK (SERVER DOWN / TIMEOUT / 502) ---
      // We DO NOT refund here. We keep the money and log for you to bundle manually.
      await supabase.from('transactions').insert({
        user_id: user.id, type: 'purchase', network, size, amount, recipient, status: 'pending', 
        order_ref: orderRef, note: "MANUAL BUNDLE REQUIRED: " + apiErr.message
      });

      return res.status(200).json({ 
        success: true, 
        new_balance: newBal, 
        message: "Order logged. Delivering manually due to system lag." 
      });
    }

  } catch (err) {
    console.error("Global Error:", err.message);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};
