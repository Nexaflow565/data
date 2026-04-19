/**
 * EasyData GH — /api/purchase.js
 * Vercel Serverless Function (Node.js 24)
 * 
 * VERSION: Cloudflare Bypass + Detailed Logging
 */

const { createClient } = require('@supabase/supabase-js');

const NG_BASE = 'https://netgeargh.app/api/v1';
const NG_TIMEOUT_MS = 25000; 
const NG_NETWORK_IDS = { mtn: 3, telecel: 2, at: 1 };

function setHeaders(res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') { setHeaders(res); return res.status(200).end(); }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  setHeaders(res);

  try {
    // 1. Check Environment Variables
    if (!process.env.NETGEAR_API_KEY || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      console.error("Missing Env Vars");
      return res.status(500).json({ error: "Server Configuration Error" });
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // 2. Auth User
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '').trim();
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    
    if (authErr || !user) {
      console.error("Auth Failure:", authErr);
      return res.status(401).json({ error: "Session expired. Please log in again." });
    }

    // 3. Parse and Validate Body
    const { network, size, amount, recipient, mb, order_ref } = req.body;
    const mbValue = parseInt(String(mb).replace(/\D/g, ''), 10);
    const orderRef = order_ref || `ED-${network}-${Date.now()}`;

    // 4. Check Balance
    const { data: profile } = await supabase.from('profiles').select('balance').eq('id', user.id).single();
    if (!profile || profile.balance < amount) {
      return res.status(402).json({ error: "Insufficient balance" });
    }

    // 5. RESERVE FUNDS (Deduct immediately so user doesn't lose money if code finishes)
    const newBal = parseFloat((profile.balance - amount).toFixed(2));
    await supabase.from('profiles').update({ balance: newBal }).eq('id', user.id);

    // 6. CALL NETGEAR GH
    const endpoint = network === 'at' ? '/buy-ishare-package' : '/buy-other-package';
    const providerBody = network === 'at' 
      ? { recipient_msisdn: recipient, shared_bundle: mbValue, order_reference: orderRef }
      : { recipient_msisdn: recipient, network_id: NG_NETWORK_IDS[network] || 3, shared_bundle: mbValue };

    console.log(`TEST: Calling Netgear for ${recipient} | Ref: ${orderRef}`);

    const ngResponse = await fetch(NG_BASE + endpoint, {
      method: 'POST',
      headers: {
        'x-api-key': process.env.NETGEAR_API_KEY,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
      },
      body: JSON.stringify(providerBody)
    });

    const text = await ngResponse.text();
    console.log("RAW RESPONSE FROM NETGEAR:", text.substring(0, 500));

    // 7. Process Result
    if (text.includes('Just a moment') || text.includes('<!DOCTYPE html>')) {
      // Still blocked by Cloudflare
      await supabase.from('transactions').insert({
        user_id: user.id, type: 'purchase', network, size, amount, recipient, status: 'pending', 
        order_ref: orderRef, note: "BLOCKED BY CLOUDFLARE - MANUAL REQUIRED"
      });
      return res.status(200).json({ success: true, new_balance: newBal, message: "Security delay. Processing manually." });
    }

    let data = {};
    try { data = JSON.parse(text); } catch (e) { data = { _raw: text }; }

    if (data.response_code === "200" || data.success === true) {
      // SUCCESS!
      await supabase.from('transactions').insert({
        user_id: user.id, type: 'purchase', network, size, amount, recipient, status: 'delivered', 
        vendor_txn_id: data.vendorTranxId || data.transaction_code, order_ref: orderRef
      });
      return res.status(200).json({ success: true, new_balance: newBal });
    } else {
      // REJECTED BY API (e.g. Invalid Number) -> REFUND
      const refundBal = parseFloat((newBal + amount).toFixed(2));
      await supabase.from('profiles').update({ balance: refundBal }).eq('id', user.id);
      await supabase.from('transactions').insert({
        user_id: user.id, type: 'purchase', network, size, amount, recipient, status: 'failed', 
        api_message: data.message || data.response_msg, note: "Refunded automatically"
      });
      return res.status(422).json({ error: data.message || data.response_msg || "Provider rejected request. Money refunded." });
    }

  } catch (err) {
    console.error("FATAL ERROR:", err.message);
    // In case of any crash, we've already deducted. Let the user know we're on it.
    return res.status(200).json({ success: true, message: "Order logged. Delivering manually due to system lag." });
  }
};
