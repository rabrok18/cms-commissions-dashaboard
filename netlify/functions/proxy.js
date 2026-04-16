const https = require('https');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const apiUrl    = process.env.BUILDOPS_API_URL    || 'https://api.buildops.com';
  const tenantId  = process.env.BUILDOPS_TENANT_ID  || '';
  const clientId  = process.env.BUILDOPS_CLIENT_ID  || '';
  const clientSec = process.env.BUILDOPS_CLIENT_SECRET || '';

  const allowed = ['/v1/jobs', '/v1/invoices', '/v1/employees', '/v1/customers', '/v1/quotes', '/v1/settings'];
  const params  = event.queryStringParameters || {};
  const endpoint = params.endpoint || '';

  if (!endpoint || !allowed.some(p => endpoint.startsWith(p))) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Endpoint not allowed: ' + endpoint }) };
  }

  // Get token
  let token;
  try {
    token = await getToken(apiUrl, clientId, clientSec);
  } catch(e) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Auth failed: ' + e.message }) };
  }

  // Build query string from remaining params
  const skip = new Set(['endpoint']);
  const qs = Object.entries(params).filter(([k]) => !skip.has(k)).map(([k,v]) => k+'='+encodeURIComponent(v)).join('&');
  const fullPath = endpoint + (qs ? '?' + qs : '');

  try {
    const data = await apiGet(apiUrl + fullPath, token, tenantId);
    return { statusCode: 200, headers, body: data };
  } catch(e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};

function getToken(apiUrl, clientId, clientSecret) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ clientId, clientSecret });
    const url  = new URL(apiUrl + '/v1/auth/token');
    const opts = { hostname: url.hostname, path: url.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          const t = j.access_token || j.token || j.accessToken;
          if (!t) reject(new Error('No token: ' + d.slice(0,100)));
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
    const opts = { hostname: u.hostname, path: u.pathname + (u.search||''), method: 'GET',
      headers: { 'Authorization': 'Bearer ' + token, 'tenantId': tenantId } };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.end();
  });
}
