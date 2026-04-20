const { getStore } = require('@netlify/blobs');
const https = require('https');

// Netlify Background Function - 15 minute timeout
// Returns 202 immediately, processes async
// Triggered manually from dashboard Sync button

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
    // Initialize Blobs using explicit siteID + token (most reliable)
    const siteId = process.env.NETLIFY_SITE_ID || process.env.SITE_ID || '';
    const blobToken = process.env.NETLIFY_TOKEN || process.env.NETLIFY_ACCESS_TOKEN || process.env.NETLIFY_AUTH_TOKEN || '';
    
    console.log('[Sync] Blobs init — siteId present:', !!siteId, 'token present:', !!blobToken);
    
    let store;
    if (siteId && blobToken) {
      store = getStore({ name: 'commission', siteID: siteId, token: blobToken });
    } else {
      // Fall back to auto-detection (works when deployed via Netlify CI)
      try {
        store = getStore({ name: 'commission', consistency: 'strong' });
      } catch(e) {
        return { statusCode: 500, headers: H, body: JSON.stringify({
          error: 'Blobs not configured. Add NETLIFY_SITE_ID and NETLIFY_TOKEN env vars. Site ID: ' + (siteId||'missing') + ', Token: ' + (blobToken?'present':'missing')
        })};
      }
    }
    // Log env var presence (not values)
    console.log('[Sync] Config check — apiUrl:', !!apiUrl, 'tenantId:', !!tenantId, 'clientId:', !!clientId, 'clientSec:', !!clientSec);

    if (!clientId || !clientSec) {
      return { statusCode: 500, headers: H, body: JSON.stringify({ 
        error: 'Missing BuildOps credentials. Set BUILDOPS_CLIENT_ID and BUILDOPS_CLIENT_SECRET in Netlify environment variables.' 
      })};
    }

    // Mark as running
    await store.set('data:syncStatus', JSON.stringify({ running: true, step: 'authenticating', startedAt: new Date().toISOString() }));
    
    // Authenticate
    const token = await getToken(apiUrl, clientId, clientSec);
    console.log('[Sync] Authenticated successfully');
    await store.set('data:syncStatus', JSON.stringify({ running: true, step: 'fetching employees/customers' }));

    // Fetch all data in parallel where possible
    const results = {};
    const errors  = {};

    // Fetch employees - with raw response logging
    try {
      const empRaw = await apiGet(apiUrl + '/v1/employees?page=0&page_size=100', token, tenantId);
      console.log('[Sync] Employees raw (first 300):', empRaw.slice(0, 300));
      const empData = JSON.parse(empRaw);
      results.employees = Array.isArray(empData) ? empData : (empData.items || []);
      console.log('[Sync] Employees parsed:', results.employees.length);
    } catch(e) { errors.employees = e.message; console.error('[Sync] Employees error:', e.message); }

    // Fetch customers - with raw response logging
    try {
      const custRaw = await apiGet(apiUrl + '/v1/customers?page=0&page_size=100', token, tenantId);
      console.log('[Sync] Customers raw (first 300):', custRaw.slice(0, 300));
      const custData = JSON.parse(custRaw);
      results.customers = Array.isArray(custData) ? custData : (custData.items || []);
      console.log('[Sync] Customers parsed:', results.customers.length);
    } catch(e) { errors.customers = e.message; console.error('[Sync] Customers error:', e.message); }

    // Fetch jobs, invoices, quotes (paginated, do sequentially to avoid rate limits)
    for (const [key, path, pageSize] of [
      ['jobs',     '/v1/jobs',     100],
      ['invoices', '/v1/invoices', 100],
      ['quotes',   '/v1/quotes',   100],
    ]) {
      try {
        await store.set('data:syncStatus', JSON.stringify({ running: true, step: 'fetching ' + key }));
        const data = await fetchAll(apiUrl, token, tenantId, path, pageSize);
        results[key] = data;
        console.log(`[Sync] ${key}:`, data.length);
        // Save each dataset as we go so dashboard can show partial data
        await store.set('data:' + key, JSON.stringify(data));
      } catch(e) {
        errors[key] = e.message;
        console.error(`[Sync] ${key} failed:`, e.message);
      }
    }

    // Store each dataset in Blobs
    const syncedAt = new Date().toISOString();
    await store.set('data:syncStatus', JSON.stringify({ running: true, step: 'writing', startedAt: syncedAt }));
    
    for (const [key, data] of Object.entries(results)) {
      await store.set('data:' + key, JSON.stringify(data));
    }
    await store.set('data:syncedAt', syncedAt);
    await store.set('data:syncErrors', JSON.stringify(errors));
    await store.set('data:syncStatus', JSON.stringify({ running: false, completedAt: new Date().toISOString() }));

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
    // Try both page_size and limit params (BuildOps accepts both)
    const url = apiUrl + path + '?page=' + page + '&page_size=' + pageSize + '&limit=' + pageSize;
    console.log('[Sync] Fetching:', url.replace(apiUrl,''));
    const raw = await apiGet(url, token, tenantId);
    const d   = JSON.parse(raw);
    const items = Array.isArray(d) ? d : (d.items || []);
    all = all.concat(items);
    const total = (d.query && d.query.totalCount) || d.totalCount || 0;
    console.log('[Sync] Page', page, '— got', items.length, 'items, total:', total, 'collected:', all.length);
    // Stop if we got everything or got a short page
    if (items.length === 0) break;
    if (total > 0 && all.length >= total) break;
    if (items.length < pageSize) break;
    page++;
    await new Promise(r => setTimeout(r, 150));
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
