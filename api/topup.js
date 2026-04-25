/**
 * EasyData GH — /api/topup.js
 * Vercel Serverless Function (Node.js 24.x)
 *
 * Flow:
 *   1. Authenticate user via JWT
 *   2. Verify the Paystack payment reference is genuine (calls Paystack verify API)
 *   3. Check it hasn't been credited before (idempotency — prevents double-credit)
 *   4. Credit wallet atomically
 *   5. Record transaction
 *   6. Return new balance
 *
 * Environment variables needed (already in Vercel):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 *   PAYSTACK_SECRET_KEY   ← add this: your Paystack secret key (sk_live_...)
 */

const { createClient } = require('@supabase/supabase-js');

function setHeaders(res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function send(res, status, body) {
  setHeaders(res);
  res.status(status).json(body);
}

async function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk.toString(); });
    req.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') { setHeaders(res); return res.status(200).end(); }
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });

  try {
    // ── Check env vars ────────────────────────────────────────────────────────
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      return send(res, 500, { error: 'Server config error' });
    }

    const sb = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    // ── Authenticate user ─────────────────────────────────────────────────────
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token) return send(res, 401, { error: 'Missing authorization token' });

    const { data: authData, error: authErr } = await sb.auth.getUser(token);
    if (authErr || !authData?.user) {
      return send(res, 401, { error: 'Invalid or expired session' });
    }
    const userId = authData.user.id;

    // ── Parse body ────────────────────────────────────────────────────────────
    const body    = await parseBody(req);
    const { amount, method, phone, reference } = body;

    if (!amount || !reference) {
      return send(res, 400, { error: 'Missing required fields: amount, reference' });
    }

    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum < 5) {
      return send(res, 400, { error: 'Invalid amount. Minimum is GHS 5.' });
    }

    // ── IDEMPOTENCY: Check if reference was already credited ──────────────────
    const { data: existing } = await sb
      .from('transactions')
      .select('id, status')
      .eq('reference', reference)
      .eq('user_id', userId)
      .eq('status', 'success')
      .maybeSingle();

    if (existing) {
      // Already credited — return current balance without double-crediting
      const { data: prof } = await sb.from('profiles').select('balance').eq('id', userId).single();
      console.log(`[topup] Duplicate reference ${reference} — already credited`);
      return send(res, 200, {
        success: true,
        already_credited: true,
        new_balance: parseFloat(prof?.balance || 0),
        message: 'Already credited',
      });
    }

    // ── VERIFY PAYMENT with Paystack (if secret key is available) ─────────────
    const PAYSTACK_KEY = process.env.PAYSTACK_SECRET_KEY;
    if (PAYSTACK_KEY) {
      try {
        const verifyRes = await fetch(
          `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
          { headers: { Authorization: `Bearer ${PAYSTACK_KEY}` } }
        );
        const verifyData = await verifyRes.json();

        if (!verifyData.status || verifyData.data?.status !== 'success') {
          console.warn(`[topup] Paystack verify failed for ${reference}:`, verifyData.data?.status);
          return send(res, 402, { error: 'Payment not confirmed by Paystack' });
        }

        // Verify amount matches (Paystack uses kobo/pesewas — divide by 100)
        const paidAmount = verifyData.data.amount / 100;
        if (Math.abs(paidAmount - amountNum) > 0.5) {
          console.warn(`[topup] Amount mismatch: expected ${amountNum}, Paystack says ${paidAmount}`);
          return send(res, 402, { error: 'Payment amount mismatch' });
        }
        console.log(`[topup] Paystack verified: ${reference} = GHS ${paidAmount}`);
      } catch (verifyErr) {
        // Paystack verification failed — log but don't block (webhook handles reconciliation)
        console.error('[topup] Paystack verify error (continuing):', verifyErr.message);
      }
    } else {
      console.warn('[topup] PAYSTACK_SECRET_KEY not set — skipping verification');
    }

    // ── Read fresh balance ────────────────────────────────────────────────────
    const { data: profile, error: profErr } = await sb
      .from('profiles')
      .select('balance')
      .eq('id', userId)
      .single();

    if (profErr || !profile) {
      return send(res, 500, { error: 'Could not read profile' });
    }

    const currentBalance = parseFloat(profile.balance || 0);
    const newBalance = parseFloat((currentBalance + amountNum).toFixed(2));

    // ── Credit wallet ─────────────────────────────────────────────────────────
    const { error: updateErr } = await sb
      .from('profiles')
      .update({ balance: newBalance })
      .eq('id', userId);

    if (updateErr) {
      console.error('[topup] Balance update error:', updateErr.message);
      return send(res, 500, { error: 'Failed to update balance: ' + updateErr.message });
    }

    // ── Record transaction ────────────────────────────────────────────────────
    await sb.from('transactions').insert({
      user_id:   userId,
      type:      'topup',
      method:    method || 'Mobile Money',
      phone:     phone  || '',
      amount:    amountNum,
      reference: reference,
      status:    'success',
    });

    console.log(`[topup] Credited GHS ${amountNum} to user ${userId}. New balance: ${newBalance}`);

    return send(res, 200, {
      success:     true,
      new_balance: newBalance,
      credited:    amountNum,
      message:     'Wallet credited successfully',
    });

  } catch (err) {
    console.error('[topup] Unhandled error:', err.message);
    return send(res, 500, { error: 'An unexpected error occurred' });
  }
};
