// proxy.js — BuildOps API proxy
// Uses Node.js built-in fetch (available in Node 18+, which Netlify uses by default)
// No npm dependencies needed.

const API_URL       = process.env.BUILDOPS_API_URL     || 'https://api.buildops.com';
const TENANT_ID     = process.env.BUILDOPS_TENANT_ID;
const CLIENT_ID     = process.env.BUILDOPS_CLIENT_ID;
const CLIENT_SECRET = process.env.BUILDOPS_CLIENT_SECRET;

let _token = null;
let _tokenExpiry = 0;

async function getToken() {
  if (_token && Date.now() < _tokenExpiry) return _token;
  const res = await fetch(`${API_URL}/v1/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET })
  });
  if (!res.ok) throw new Error(`Auth failed (${res.status})`);
  const data = await res.json();
  _token = data.access_token || data.token || data.accessToken || data.id_token;
  if (!_token) throw new Error('No token in auth response');
  _tokenExpiry = Date.now() + 50 * 60 * 1000;
  return _token;
}

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  if (!TENANT_ID || !CLIENT_ID || !CLIENT_SECRET) {
    return { statusCode: 500, headers, body: JSON.stringify({
      error: 'Missing env vars. Set BUILDOPS_TENANT_ID, BUILDOPS_CLIENT_ID, BUILDOPS_CLIENT_SECRET in Netlify.'
    })};
  }

  try {
    const params = event.queryStringParameters || {};
    const endpoint = params.endpoint;
    const allowed  = ['/v1/quotes', '/v1/invoices', '/v1/properties', '/v1/customers', '/v1/employees', '/v1/jobs', '/v1/settings', '/v1/payments'];

    if (!endpoint || !allowed.some(p => endpoint.startsWith(p))) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Endpoint not allowed' }) };
    }

    const forward = Object.entries(params)
      .filter(([k]) => k !== 'endpoint')
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');

    const url   = `${API_URL}${endpoint}${forward ? '?' + forward : ''}`;
    const token = await getToken();
    const res   = await fetch(url, { headers: { 'Authorization': `Bearer ${token}`, 'tenantId': TENANT_ID } });
    const text  = await res.text();

    return { statusCode: res.status, headers, body: text };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
