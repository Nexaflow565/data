/**
 * EasyData GH — /api/fetch-packages.js
 * Temporary diagnostic endpoint — call this ONCE to see exact package IDs
 * from NetgearGH so you can map them correctly in BD bundle data.
 *
 * Call it by visiting: https://eazydatagh.com/api/fetch-packages
 * (GET request — open in browser or Postman)
 *
 * DELETE this file after you've noted down the package volumes.
 */

const { createClient } = require('@supabase/supabase-js');

function setHeaders(res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
}

module.exports = async function handler(req, res) {
  setHeaders(res);

  const NG_KEY = process.env.NETGEAR_API_KEY;
  if (!NG_KEY) {
    return res.status(500).json({ error: 'NETGEAR_API_KEY not set' });
  }

  try {
    const response = await fetch('https://netgeargh.app/api/v1/fetch-data-packages', {
      method: 'GET',
      headers: {
        'x-api-key':      NG_KEY,
        'Accept':         'application/json',
        'Content-Type':   'application/json',
        'User-Agent':     'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept-Language':'en-US,en;q=0.9',
        'Origin':         'https://netgeargh.app',
        'Referer':        'https://netgeargh.app/',
      },
    });

    const text = await response.text();
    let data;
    try { data = JSON.parse(text); }
    catch { return res.status(200).json({ raw: text, httpStatus: response.status }); }

    // Group by network for easy reading
    const grouped = {};
    if (Array.isArray(data)) {
      data.forEach(pkg => {
        const net = pkg.network || pkg.network_id || 'unknown';
        if (!grouped[net]) grouped[net] = [];
        grouped[net].push({
          id:            pkg.id,
          name:          pkg.name,
          network:       pkg.network,
          network_id:    pkg.network_id,
          volume_MB:     pkg.volume,        // THIS is what you send as shared_bundle
          console_price: pkg.console_price,
        });
      });
    }

    return res.status(200).json({
      httpStatus: response.status,
      total_packages: Array.isArray(data) ? data.length : 0,
      packages_by_network: grouped,
      raw: data,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
