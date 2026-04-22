// sync-background.js — OPTIMIZED Netlify BACKGROUND FUNCTION (15min timeout)
// Parallelizes everything that can be parallel, batches individual lookups
const { getStore } = require('@netlify/blobs');
const https = require('https');

exports.config = {
  schedule: '0 7 * * *' // 2am ET nightly
};

const CONCURRENCY = 10; // parallel API calls (BuildOps should handle this)

exports.handler = async (event) => {
  const startTime = Date.now();
  console.log('[Sync] Started at', new Date().toISOString());

  const apiUrl    = process.env.BUILDOPS_API_URL     || 'https://api.buildops.com';
  const tenantId  = process.env.BUILDOPS_TENANT_ID   || '';
  const clientId  = process.env.BUILDOPS_CLIENT_ID   || '';
  const clientSec = process.env.BUILDOPS_CLIENT_SECRET || '';
  const siteId    = process.env.NETLIFY_SITE_ID || process.env.SITE_ID || '';
  const blobToken = process.env.NETLIFY_TOKEN || process.env.NETLIFY_ACCESS_TOKEN || '';

  let store;
  try {
    store = (siteId && blobToken)
      ? getStore({ name: 'commission', siteID: siteId, token: blobToken })
      : getStore({ name: 'commission', consistency: 'strong' });
  } catch(e) {
    console.error('[Sync] Blobs init failed:', e.message);
    return;
  }

  try {
    await store.set('data:syncStatus', JSON.stringify({ running: true, startedAt: new Date().toISOString() }));

    const token = await getToken(apiUrl, clientId, clientSec);
    console.log('[Sync] Authenticated in', ((Date.now()-startTime)/1000).toFixed(1), 's');

    const results = {};
    const errors = {};

    // ═══════════════════════════════════════════════════════════
    // PHASE 1: Parallel paginated fetches (jobs, invoices, quotes, payments)
    // All run at once since they're independent
    // ═══════════════════════════════════════════════════════════
    const p1Start = Date.now();
    const [jobsR, invoicesR, quotesR, paymentsR] = await Promise.allSettled([
      fetchAllParallel(apiUrl, token, tenantId, '/v1/jobs'),
      fetchAllParallel(apiUrl, token, tenantId, '/v1/invoices'),
      fetchAllParallel(apiUrl, token, tenantId, '/v1/quotes'),
      fetchAllParallel(apiUrl, token, tenantId, '/v1/payments'),
    ]);

    if (jobsR.status === 'fulfilled') { results.jobs = jobsR.value; await store.set('data:jobs', JSON.stringify(results.jobs)); }
    else { errors.jobs = jobsR.reason.message; results.jobs = []; }

    if (invoicesR.status === 'fulfilled') { results.invoices = invoicesR.value; await store.set('data:invoices', JSON.stringify(results.invoices)); }
    else { errors.invoices = invoicesR.reason.message; results.invoices = []; }

    if (quotesR.status === 'fulfilled') { results.quotes = quotesR.value; await store.set('data:quotes', JSON.stringify(results.quotes)); }
    else { errors.quotes = quotesR.reason.message; results.quotes = []; }

    if (paymentsR.status === 'fulfilled') { results.payments = paymentsR.value; await store.set('data:payments', JSON.stringify(results.payments)); }
    else { errors.payments = paymentsR.reason.message; results.payments = []; }

    console.log('[Sync] Phase 1 (parallel paginated) done in', ((Date.now()-p1Start)/1000).toFixed(1), 's',
      '— jobs:', results.jobs.length, 'invoices:', results.invoices.length,
      'quotes:', results.quotes.length, 'payments:', results.payments.length);

    // ═══════════════════════════════════════════════════════════
    // PHASE 2: Parallel individual lookups (employees + customers)
    // Collect unique IDs, then batch with high concurrency
    // ═══════════════════════════════════════════════════════════
    const p2Start = Date.now();

    const empIds = new Set();
    results.jobs.forEach(j => {
      if (j.soldById) empIds.add(j.soldById);
      if (j.accountManagerId) empIds.add(j.accountManagerId);
      if (j.ownerId) empIds.add(j.ownerId);
    });

    const custIds = new Set();
    results.jobs.forEach(j => { if (j.billingCustomerId) custIds.add(j.billingCustomerId); });
    results.invoices.forEach(i => { if (i.billingCustomerId) custIds.add(i.billingCustomerId); });

    console.log('[Sync] Phase 2 — fetching', empIds.size, 'employees and', custIds.size, 'customers in parallel (concurrency='+CONCURRENCY+')');

    // Parallel batched individual fetches
    const [emps, custs] = await Promise.all([
      fetchByIdsParallel(apiUrl, token, tenantId, '/v1/employees', [...empIds]),
      fetchByIdsParallel(apiUrl, token, tenantId, '/v1/customers', [...custIds]),
    ]);

    results.employees = emps;
    results.customers = custs;
    await store.set('data:employees', JSON.stringify(results.employees));
    await store.set('data:customers', JSON.stringify(results.customers));

    console.log('[Sync] Phase 2 done in', ((Date.now()-p2Start)/1000).toFixed(1), 's',
      '— employees:', emps.length, 'customers:', custs.length);

    // ═══════════════════════════════════════════════════════════
    // PHASE 3: Fetch customer tag master list (all defined tags in BuildOps)
    // ═══════════════════════════════════════════════════════════
    try {
      const tagList = await fetchAllParallel(apiUrl, token, tenantId, '/v1/settings/custom-fields/customer-tags');
      results.customerTagList = tagList;
      console.log('[Sync] Customer tag definitions:', tagList.length);
      if (tagList.length > 0) {
        console.log('[Sync] Sample tag:', JSON.stringify(tagList[0]));
        console.log('[Sync] All tag names:', tagList.map(t => t.tagName || t.name).filter(Boolean).join(', '));
      }
      await store.set('data:customerTagList', JSON.stringify(tagList));
    } catch(e) {
      errors.customerTagList = e.message;
      console.error('[Sync] Tag list fetch failed:', e.message);
    }

    // Log sample customer to inspect tag field
    if (custs.length > 0) {
      console.log('[Sync] Sample customer:', JSON.stringify(custs[0]).slice(0, 600));
    }

    // ═══════════════════════════════════════════════════════════
    // Save final status
    // ═══════════════════════════════════════════════════════════
    const syncedAt = new Date().toISOString();
    await store.set('data:syncedAt', syncedAt);
    await store.set('data:syncErrors', JSON.stringify(errors));
    await store.set('data:syncStatus', JSON.stringify({
      running: false, completedAt: syncedAt,
      duration: (Date.now()-startTime)/1000,
      counts: Object.fromEntries(Object.entries(results).map(([k,v]) => [k, v.length]))
    }));

    console.log('[Sync] COMPLETE in', ((Date.now()-startTime)/1000).toFixed(1), 's',
      '— totals:', Object.entries(results).map(([k,v]) => `${k}:${v.length}`).join(' '));

  } catch(err) {
    console.error('[Sync] FATAL:', err.message);
    try {
      await store.set('data:syncStatus', JSON.stringify({
        running: false, error: err.message, failedAt: new Date().toISOString()
      }));
    } catch(e) {}
  }
};

// ═══════════════════════════════════════════════════════════
// PARALLEL pagination — fetches page 0 first, then all remaining pages in parallel
// ═══════════════════════════════════════════════════════════
async function fetchAllParallel(apiUrl, token, tenantId, path) {
  const pageSize = 100;

  // Fetch page 0 to learn total count
  const page0Url = `${apiUrl}${path}?page=0&page_size=${pageSize}&limit=${pageSize}`;
  const page0Raw = await apiGet(page0Url, token, tenantId);
  const page0 = JSON.parse(page0Raw);
  const items0 = Array.isArray(page0) ? page0 : (page0.items || []);
  const total = (page0.query && page0.query.totalCount) || page0.totalCount || 0;

  // If we got all records in page 0, or there's no total, we're done
  if (total === 0 || items0.length >= total || items0.length < pageSize) {
    return items0;
  }

  const totalPages = Math.ceil(total / pageSize);
  console.log(`[Sync] ${path}: total ${total}, fetching ${totalPages-1} more pages in parallel batches`);

  // Fetch remaining pages in parallel batches
  const pagesRemaining = [];
  for (let p = 1; p < totalPages; p++) pagesRemaining.push(p);

  const all = [...items0];
  // Process in batches to avoid overwhelming the API
  for (let i = 0; i < pagesRemaining.length; i += CONCURRENCY) {
    const batch = pagesRemaining.slice(i, i + CONCURRENCY);
    const pageResults = await Promise.all(batch.map(async p => {
      const url = `${apiUrl}${path}?page=${p}&page_size=${pageSize}&limit=${pageSize}`;
      try {
        const raw = await apiGet(url, token, tenantId);
        const d = JSON.parse(raw);
        return Array.isArray(d) ? d : (d.items || []);
      } catch(e) {
        console.warn(`[Sync] ${path} page ${p} failed:`, e.message);
        return [];
      }
    }));
    pageResults.forEach(items => all.push(...items));
  }

  return all;
}

// ═══════════════════════════════════════════════════════════
// PARALLEL individual lookups (employees, customers by ID)
// Batches with concurrency to avoid rate limiting
// ═══════════════════════════════════════════════════════════
async function fetchByIdsParallel(apiUrl, token, tenantId, path, ids) {
  const results = [];
  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    const batch = ids.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(async id => {
      try {
        const raw = await apiGet(`${apiUrl}${path}/${id}`, token, tenantId);
        const obj = JSON.parse(raw);
        return obj && obj.id ? obj : null;
      } catch(e) { return null; }
    }));
    batchResults.forEach(r => { if (r) results.push(r); });
  }
  return results;
}

// ═══════════════════════════════════════════════════════════
// AUTH + REQUEST HELPERS
// ═══════════════════════════════════════════════════════════
function getToken(apiUrl, clientId, clientSecret) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ clientId, clientSecret });
    const url = new URL(apiUrl + '/v1/auth/token');
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
          if (!t) reject(new Error('No token'));
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
      hostname: u.hostname,
      path: u.pathname + (u.search || ''),
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + token,
        'tenantId': tenantId,
        'Accept-Encoding': 'gzip, deflate'
      }
    };
    const req = https.request(opts, res => {
      const chunks = [];
      let stream = res;
      // Handle gzip response
      if (res.headers['content-encoding'] === 'gzip') {
        const zlib = require('zlib');
        stream = res.pipe(zlib.createGunzip());
      } else if (res.headers['content-encoding'] === 'deflate') {
        const zlib = require('zlib');
        stream = res.pipe(zlib.createInflate());
      }
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy(new Error('Request timeout after 30s'));
    });
    req.end();
  });
}
