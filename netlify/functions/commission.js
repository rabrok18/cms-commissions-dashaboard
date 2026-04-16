const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  const H = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Password, X-User-Password',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: H, body: '' };

  const adminPw = process.env.ADMIN_PASSWORD || '';
  const body = event.body ? (() => { try { return JSON.parse(event.body); } catch { return {}; } })() : {};
  const qs = event.queryStringParameters || {};
  const action = body.action || qs.action || '';
  const incomingAdmin = (event.headers && (event.headers['x-admin-password'] || event.headers['X-Admin-Password'])) || '';
  const isAdmin = adminPw && incomingAdmin === adminPw;

  function store() {
    return getStore({ name: 'commission', consistency: 'strong' });
  }
  async function blobGet(key) {
    try { return await store().get(key); } catch (e) { console.warn('blobGet failed:', key, e.message); return null; }
  }
  async function blobSet(key, val) {
    try { await store().set(key, val); return true; } catch (e) { console.warn('blobSet failed:', key, e.message); return false; }
  }

  try {

    // ── LOGIN ────────────────────────────────────────────
    if (action === 'login') {
      const pw = body.password || '';

      if (adminPw && pw === adminPw) {
        return { statusCode: 200, headers: H, body: JSON.stringify({ role: 'admin', name: 'Admin' }) };
      }

      const usersRaw = await blobGet('users');
      const users = usersRaw ? JSON.parse(usersRaw) : [];
      const user = users.find(u => u.active && u.password === pw);
      if (user) {
        return {
          statusCode: 200, headers: H, body: JSON.stringify({
            role: 'rep', name: user.name,
            employeeId: user.buildopsEmployeeId, userId: user.id,
          })
        };
      }

      return { statusCode: 401, headers: H, body: JSON.stringify({ error: 'Invalid password' }) };
    }

    // ── GET cached data (public) ─────────────────────────
    if (event.httpMethod === 'GET' && action === 'data') {
      const key = qs.key || '';
      if (!key) return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'Missing key' }) };
      const raw = await blobGet('data:' + key);
      if (!raw) return { statusCode: 200, headers: H, body: JSON.stringify({ items: [], cached: false }) };
      try {
        const parsed = JSON.parse(raw);
        return { statusCode: 200, headers: H, body: JSON.stringify({ items: parsed, cached: true }) };
      } catch {
        // syncedAt and syncErrors are plain strings, not arrays
        return { statusCode: 200, headers: H, body: JSON.stringify({ value: raw, cached: true }) };
      }
    }

    // ── GET sync status (public) ─────────────────────────
    if (event.httpMethod === 'GET' && action === 'syncStatus') {
      const syncedAt = await blobGet('data:syncedAt');
      const errRaw = await blobGet('data:syncErrors');
      const errors = errRaw ? JSON.parse(errRaw) : {};
      return { statusCode: 200, headers: H, body: JSON.stringify({ syncedAt, errors }) };
    }

    // ── GET rates (public — reps need rates for client-side calc) ──
    if (event.httpMethod === 'GET' && action === 'rates') {
      const raw = await blobGet('rates');
      const rates = raw ? JSON.parse(raw) : { house: 3, rep: 5, none: 5, cbDays: 90 };
      return { statusCode: 200, headers: H, body: JSON.stringify({ rates }) };
    }

    // ── GET payouts — admin sees all, rep sees own ───────
    if (event.httpMethod === 'GET' && action === 'payouts') {
      const repId = qs.repId || '';
      const raw = await blobGet('payouts');
      let payouts = raw ? JSON.parse(raw) : [];
      payouts = payouts.filter(p => !p.voided);

      // Rep auth: check user password against users list
      if (!isAdmin) {
        const userPw = (event.headers && (event.headers['x-user-password'] || event.headers['X-User-Password'])) || '';
        const usersRaw = await blobGet('users');
        const users = usersRaw ? JSON.parse(usersRaw) : [];
        const user = users.find(u => u.active && u.password === userPw);
        if (!user) {
          return { statusCode: 403, headers: H, body: JSON.stringify({ error: 'Auth required' }) };
        }
        // Rep can only see their own payouts
        payouts = payouts.filter(p => p.repId === user.buildopsEmployeeId);
      } else if (repId) {
        payouts = payouts.filter(p => p.repId === repId);
      }

      return { statusCode: 200, headers: H, body: JSON.stringify({ payouts }) };
    }

    // ── ADMIN ONLY below ─────────────────────────────────
    if (!isAdmin) {
      return { statusCode: 403, headers: H, body: JSON.stringify({ error: 'Admin access required' }) };
    }

    // GET users
    if (event.httpMethod === 'GET' && action === 'users') {
      const raw = await blobGet('users');
      const users = raw ? JSON.parse(raw) : [];
      return {
        statusCode: 200, headers: H, body: JSON.stringify({
          users: users.map(u => ({ ...u, password: '••••••' }))
        })
      };
    }

    // POST save rates
    if (event.httpMethod === 'POST' && action === 'saveRates') {
      if (!body.rates) return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'Missing rates' }) };
      // Normalize keys — always store as { house, rep, none, cbDays }
      const r = body.rates;
      const normalized = {
        house: parseFloat(r.house) || 3,
        rep: parseFloat(r.rep) || 5,
        none: parseFloat(r.none) || 5,
        cbDays: parseInt(r.cbDays || r.clawbackDays) || 90,
      };
      await blobSet('rates', JSON.stringify(normalized));
      return { statusCode: 200, headers: H, body: JSON.stringify({ success: true, rates: normalized }) };
    }

    // POST save user
    if (event.httpMethod === 'POST' && action === 'saveUser') {
      const user = body.user;
      if (!user || !user.name || (!user.id && !user.password)) {
        return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'name and password required' }) };
      }
      const raw = await blobGet('users');
      let users = raw ? JSON.parse(raw) : [];
      if (user.id) {
        const idx = users.findIndex(u => u.id === user.id);
        if (idx >= 0) {
          // Keep existing password if not provided
          if (!user.password || user.password === '••••••') user.password = users[idx].password;
          users[idx] = { ...users[idx], ...user };
        } else {
          users.push(user);
        }
      } else {
        user.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        user.active = true;
        users.push(user);
      }
      await blobSet('users', JSON.stringify(users));
      return { statusCode: 200, headers: H, body: JSON.stringify({ success: true, userId: user.id }) };
    }

    // DELETE user
    if (event.httpMethod === 'DELETE' && action === 'deleteUser') {
      if (!body.userId) return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'Missing userId' }) };
      const raw = await blobGet('users');
      let users = raw ? JSON.parse(raw) : [];
      users = users.filter(u => u.id !== body.userId);
      await blobSet('users', JSON.stringify(users));
      return { statusCode: 200, headers: H, body: JSON.stringify({ success: true }) };
    }

    // POST record payout
    if (event.httpMethod === 'POST' && action === 'recordPayout') {
      const payout = body.payout;
      if (!payout || !payout.repId || !payout.amount || !payout.month) {
        return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'repId, amount, month required' }) };
      }
      const raw = await blobGet('payouts');
      let payouts = raw ? JSON.parse(raw) : [];
      const exists = payouts.find(p => p.repId === payout.repId && p.month === payout.month && !p.voided);
      if (exists) {
        return {
          statusCode: 409, headers: H, body: JSON.stringify({
            error: 'Payout already recorded for ' + payout.repName + ' for ' + payout.month
          })
        };
      }
      payout.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      payout.paidDate = new Date().toISOString();
      payouts.push(payout);
      await blobSet('payouts', JSON.stringify(payouts));
      return { statusCode: 200, headers: H, body: JSON.stringify({ success: true, payoutId: payout.id }) };
    }

    // DELETE void payout
    if (event.httpMethod === 'DELETE' && action === 'voidPayout') {
      if (!body.payoutId) return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'Missing payoutId' }) };
      const raw = await blobGet('payouts');
      let payouts = raw ? JSON.parse(raw) : [];
      const idx = payouts.findIndex(p => p.id === body.payoutId);
      if (idx === -1) return { statusCode: 404, headers: H, body: JSON.stringify({ error: 'Payout not found' }) };
      payouts[idx].voided = true;
      payouts[idx].voidedDate = new Date().toISOString();
      await blobSet('payouts', JSON.stringify(payouts));
      return { statusCode: 200, headers: H, body: JSON.stringify({ success: true }) };
    }

    return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'Unknown action: ' + action }) };

  } catch (err) {
    console.error('commission.js error:', err.message);
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: err.message }) };
  }
};
