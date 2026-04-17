const { getStore } = require('@netlify/blobs');
const https = require('https');

exports.config = { schedule: '0 7 * * *' }; // 2am ET

exports.handler = async (event) => {
  const H = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Password',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: H, body: '' };

  const adminPw = process.env.ADMIN_PASSWORD;
  if (event.httpMethod === 'POST' && adminPw) {
    const incoming = (event.headers && (event.headers['x-admin-password'] || event.headers['X-Admin-Password'])) || '';
    if (incoming !== adminPw) return { statusCode: 403, headers: H, body: JSON.stringify({ error: 'Admin access required' }) };
  }

  const apiUrl = process.env.BUILDOPS_API_URL || 'https://api.buildops.com';
  const tenantId = process.env.BUILDOPS_TENANT_ID || '';
  const clientId = process.env.BUILDOPS_CLIENT_ID || '';
  const clientSec = process.env.BUILDOPS_CLIENT_SECRET || '';

  try {
    const siteId = process.env.NETLIFY_SITE_ID || process.env.SITE_ID || '';
    const blobToken = process.env.NETLIFY_TOKEN || process.env.NETLIFY_ACCESS_TOKEN || '';
    let store;
    if (siteId && blobToken) store = getStore({ name: 'commission', siteID: siteId, token: blobToken });
    else try { store = getStore({ name: 'commission', consistency: 'strong' }); } catch(e) {
      return { statusCode: 500, headers: H, body: JSON.stringify({ error: 'Blobs not configured.' }) };
    }

    if (!clientId || !clientSec) return { statusCode: 500, headers: H, body: JSON.stringify({ error: 'Missing BUILDOPS_CLIENT_ID / BUILDOPS_CLIENT_SECRET.' }) };

    const token = await getToken(apiUrl, clientId, clientSec);
    console.log('[Sync] Authenticated');

    const results = {}, errors = {};

    // BuildOps API spec (2025-01-23):
    //   All list endpoints: max 100/page, default 10
    //   Employees:  page_size param
    //   Customers:  limit param (NOT page_size)
    //   Jobs:       page_size or limit
    //   Invoices:   page_size
    //   Quotes:     page_size
    const endpoints = [
      { key: 'employees', path: '/v1/employees', sizeParam: 'page_size' },
      { key: 'customers', path: '/v1/customers', sizeParam: 'limit' },
      { key: 'jobs',      path: '/v1/jobs',      sizeParam: 'page_size' },
      { key: 'invoices',  path: '/v1/invoices',  sizeParam: 'page_size' },
      { key: 'quotes',    path: '/v1/quotes',    sizeParam: 'page_size' },
    ];

    for (const ep of endpoints) {
      try {
        results[ep.key] = await fetchAll(apiUrl, token, tenantId, ep.path, ep.sizeParam);
        console.log(`[Sync] ${ep.key}: ${results[ep.key].length}`);
      } catch (e) {
        errors[ep.key] = e.message;
        console.error(`[Sync] ${ep.key} failed:`, e.message);
      }
      await new Promise(r => setTimeout(r, 300));
    }

    const syncedAt = new Date().toISOString();
    for (const [key, data] of Object.entries(results)) await store.set('data:' + key, JSON.stringify(data));
    await store.set('data:syncedAt', syncedAt);
    await store.set('data:syncErrors', JSON.stringify(errors));

    const summary = { syncedAt, counts: Object.fromEntries(Object.entries(results).map(([k,v]) => [k, v.length])), errors };
    console.log('[Sync] Complete:', JSON.stringify(summary));
    return { statusCode: 200, headers: H, body: JSON.stringify(summary) };
  } catch (err) {
    console.error('[Sync] Fatal:', err.message);
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: err.message }) };
  }
};

async function fetchAll(apiUrl, token, tenantId, path, sizeParam) {
  const PS = 100;
  let all = [], page = 0;
  while (true) {
    const url = `${apiUrl}${path}?page=${page}&${sizeParam}=${PS}`;
    const raw = await apiGet(url, token, tenantId);
    let d; try { d = JSON.parse(raw); } catch(e) { throw new Error('Bad JSON from ' + path); }
    const items = Array.isArray(d) ? d : (d.items || []);
    all = all.concat(items);
    const total = d.totalCount || (d.query && d.query.totalCount) || 0;
    console.log(`[Sync] ${path} p${page} +${items.length} =${all.length}/${total}`);
    if (items.length === 0) break;
    if (total > 0 && all.length >= total) break;
    if (total === 0 && items.length < PS) break;
    page++;
    await new Promise(r => setTimeout(r, 250));
  }
  return all;
}

function getToken(apiUrl, clientId, clientSecret) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ clientId, clientSecret });
    const url = new URL(apiUrl + '/v1/auth/token');
    const req = https.request({ hostname: url.hostname, path: url.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('Auth ' + res.statusCode + ': ' + d.slice(0,200)));
        try { const j = JSON.parse(d); j.access_token ? resolve(j.access_token) : reject(new Error('No access_token')); }
        catch(e) { reject(new Error('Auth parse fail')); }
      });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

function apiGet(url, token, tenantId) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = { 'Authorization': 'Bearer ' + token };
    if (tenantId) headers['tenantId'] = tenantId;
    const req = https.request({ hostname: u.hostname, path: u.pathname + (u.search||''), method: 'GET', headers }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => res.statusCode === 200 ? resolve(d) : reject(new Error(res.statusCode + ' ' + u.pathname + ': ' + d.slice(0,200))));
    });
    req.on('error', reject); req.end();
  });
}
