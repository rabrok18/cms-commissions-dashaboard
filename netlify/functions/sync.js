const { getStore } = require('@netlify/blobs');
const https = require('https');

// Netlify scheduled function - runs nightly at 2am ET
exports.config = {
  schedule: '0 7 * * *' // 2am ET = 7am UTC
};

exports.handler = async (event) => {
  const H = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Password',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: H, body: '' };

  // Manual trigger - check admin password if set
  const adminPw = process.env.ADMIN_PASSWORD;
  if (event.httpMethod === 'POST' && adminPw) {
    const incoming = (event.headers && (event.headers['x-admin-password'] || event.headers['X-Admin-Password'])) || '';
    console.log('[Sync] Admin auth check — header present:', !!incoming);
    if (incoming !== adminPw) {
      return { statusCode: 403, headers: H, body: JSON.stringify({ error: 'Admin access required' }) };
    }
  }

  const apiUrl    = process.env.BUILDOPS_API_URL     || 'https://api.buildops.com';
  const tenantId  = process.env.BUILDOPS_TENANT_ID   || '';
  const clientId  = process.env.BUILDOPS_CLIENT_ID   || '';
  const clientSec = process.env.BUILDOPS_CLIENT_SECRET || '';

  try {
    let store;
    try { store = getStore({ name: 'commission', consistency: 'strong' }); }
    catch(blobErr) { 
      return { statusCode: 500, headers: H, body: JSON.stringify({ error: 'Blobs not configured: ' + blobErr.message }) };
    }
    // Log env var presence (not values)
    console.log('[Sync] Config check — apiUrl:', !!apiUrl, 'tenantId:', !!tenantId, 'clientId:', !!clientId, 'clientSec:', !!clientSec);

    if (!clientId || !clientSec) {
      return { statusCode: 500, headers: H, body: JSON.stringify({ 
        error: 'Missing BuildOps credentials. Set BUILDOPS_CLIENT_ID and BUILDOPS_CLIENT_SECRET in Netlify environment variables.' 
      })};
    }

    // Authenticate
    const token = await getToken(apiUrl, clientId, clientSec);
    console.log('[Sync] Authenticated successfully');

    // Fetch all data in parallel where possible
    const results = {};
    const errors  = {};

    // Fetch employees and customers first (smaller, no pagination needed)
    await Promise.all([
      fetchAll(apiUrl, token, tenantId, '/v1/employees', 200)
        .then(d => { results.employees = d; console.log('[Sync] Employees:', d.length); })
        .catch(e => { errors.employees = e.message; console.error('[Sync] Employees failed:', e.message); }),

      fetchAll(apiUrl, token, tenantId, '/v1/customers', 500)
        .then(d => { results.customers = d; console.log('[Sync] Customers:', d.length); })
        .catch(e => { errors.customers = e.message; console.error('[Sync] Customers failed:', e.message); }),
    ]);

    // Fetch jobs, invoices, quotes (paginated, do sequentially to avoid rate limits)
    for (const [key, path, pageSize] of [
      ['jobs',     '/v1/jobs',     100],
      ['invoices', '/v1/invoices', 100],
      ['quotes',   '/v1/quotes',   100],
    ]) {
      try {
        const data = await fetchAll(apiUrl, token, tenantId, path, pageSize);
        results[key] = data;
        console.log(`[Sync] ${key}:`, data.length);
      } catch(e) {
        errors[key] = e.message;
        console.error(`[Sync] ${key} failed:`, e.message);
      }
    }

    // Store each dataset in Blobs
    const syncedAt = new Date().toISOString();
    for (const [key, data] of Object.entries(results)) {
      await store.set('data:' + key, JSON.stringify(data));
    }
    await store.set('data:syncedAt', syncedAt);
    await store.set('data:syncErrors', JSON.stringify(errors));

    const summary = {
      syncedAt,
      counts: Object.fromEntries(Object.entries(results).map(([k,v]) => [k, v.length])),
      errors,
    };
    console.log('[Sync] Complete:', JSON.stringify(summary));
    return { statusCode: 200, headers: H, body: JSON.stringify(summary) };

  } catch(err) {
    console.error('[Sync] Fatal error:', err.message);
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: err.message }) };
  }
};

async function fetchAll(apiUrl, token, tenantId, path, pageSize) {
  let all = [], page = 0;
  while (true) {
    const url = apiUrl + path + '?page=' + page + '&page_size=' + pageSize;
    const raw = await apiGet(url, token, tenantId);
    const d   = JSON.parse(raw);
    const items = Array.isArray(d) ? d : (d.items || []);
    all = all.concat(items);
    const total = (d.query && d.query.totalCount) || d.totalCount || 0;
    if (items.length < pageSize || (total > 0 && all.length >= total)) break;
    page++;
    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 100));
  }
  return all;
}

function getToken(apiUrl, clientId, clientSecret) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ clientId, clientSecret });
    const url  = new URL(apiUrl + '/v1/auth/token');
    const opts = {
      hostname: url.hostname, path: url.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          const t = j.access_token || j.token || j.accessToken;
          if (!t) reject(new Error('No token: ' + d.slice(0, 100)));
          else resolve(t);
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function apiGet(url, token, tenantId) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname, path: u.pathname + (u.search || ''), method: 'GET',
      headers: { 'Authorization': 'Bearer ' + token, 'tenantId': tenantId }
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.end();
  });
}
