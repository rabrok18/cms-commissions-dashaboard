// commission.js — user management + commission config via Netlify Blobs
const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  const H = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Password, X-User-Password',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: H, body: '' };

  const adminPw  = process.env.ADMIN_PASSWORD;
  const incomingAdmin = event.headers['x-admin-password'] || '';
  const incomingUser  = event.headers['x-user-password']  || '';
  const isAdmin = adminPw && incomingAdmin === adminPw;

  const body  = event.body ? JSON.parse(event.body) : {};
  
  // Lazy store initialization - only when needed
  let store;
  function getCommStore() {
    if (!store) store = getStore({ name: 'commission', consistency: 'strong' });
    return store;
  }
  const action = body.action || (event.queryStringParameters || {}).action || '';

  try {

    // ── PUBLIC: login check ──────────────────────────────
    // DEBUG - remove after testing
    if (action === 'debug') {
      return { statusCode: 200, headers: H, body: JSON.stringify({
        adminPwSet: !!adminPw,
        adminPwLength: adminPw ? adminPw.length : 0,
        adminPwFirst3: adminPw ? adminPw.slice(0,3) : '',
        bodyReceived: body,
      })};
    }

    if (action === 'login') {
      const pw = body.password || '';

      // Check admin first - no Blobs needed
      if (adminPw && pw === adminPw) {
        return { statusCode: 200, headers: H, body: JSON.stringify({ role: 'admin', name: 'Admin' }) };
      }

      // Check rep users from Blobs
      let usersRaw = null;
      try { usersRaw = await getCommStore().get('users'); } catch(e) { console.log('Blobs error:', e.message); }
      const users = usersRaw ? JSON.parse(usersRaw) : [];
      const user  = users.find(u => u.active && u.password === pw);
      if (user) {
        return { statusCode: 200, headers: H, body: JSON.stringify({
          role: 'rep',
          name: user.name,
          employeeId: user.buildopsEmployeeId,
          userId: user.id,
        })};
      }

      return { statusCode: 401, headers: H, body: JSON.stringify({ error: 'Invalid password' }) };
    }

    // ── REP: read own payouts ────────────────────────────
    if (!isAdmin && action === 'payouts') {
      const repId = (event.queryStringParameters || {}).repId;
      if (!repId) return { statusCode: 403, headers: H, body: JSON.stringify({ error: 'repId required for rep access' }) };
      // Verify this repId belongs to a real user (check users store)
      let usersRaw2 = null;
      try { usersRaw2 = await getCommStore().get('users'); } catch(e) {}
      const users2 = usersRaw2 ? JSON.parse(usersRaw2) : [];
      const validRep = users2.find(u => u.buildopsEmployeeId === repId && u.active);
      if (!validRep) return { statusCode: 403, headers: H, body: JSON.stringify({ error: 'Not authorized' }) };
      let raw = null;
      try { raw = await getCommStore().get('payouts'); } catch(e) {}
      const payouts = raw ? JSON.parse(raw) : [];
      return { statusCode: 200, headers: H, body: JSON.stringify({
        payouts: payouts.filter(p => p.repId === repId && !p.voided)
      })};
    }

    // ── ADMIN ONLY from here ─────────────────────────────
    if (!isAdmin) {
      return { statusCode: 403, headers: H, body: JSON.stringify({ error: 'Admin access required' }) };
    }

    // GET users
    if (event.httpMethod === 'GET' && action === 'users') {
      let raw = null;
      try { raw = await getCommStore().get('users'); } catch(e) {}
      const users = raw ? JSON.parse(raw) : [];
      // Strip passwords from response
      return { statusCode: 200, headers: H, body: JSON.stringify({
        users: users.map(u => ({ ...u, password: '••••••' }))
      })};
    }

    // GET rates config
    if (event.httpMethod === 'GET' && action === 'rates') {
      let raw = null;
      try { raw = await getCommStore().get('rates'); } catch(e) {}
      const rates = raw ? JSON.parse(raw) : { house: 3, rep: 5, none: 5, clawbackDays: 90 };
      return { statusCode: 200, headers: H, body: JSON.stringify({ rates }) };
    }

    // POST save rates
    if (event.httpMethod === 'POST' && action === 'saveRates') {
      const { rates } = body;
      if (!rates) return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'Missing rates' }) };
      await getCommStore().set('rates', JSON.stringify(rates));
      return { statusCode: 200, headers: H, body: JSON.stringify({ success: true }) };
    }

    // POST add/update user
    if (event.httpMethod === 'POST' && action === 'saveUser') {
      const { user } = body;
      if (!user || !user.name || !user.password) {
        return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'name and password required' }) };
      }
      let raw = null;
      try { raw = await getCommStore().get('users'); } catch(e) {}
      let users = raw ? JSON.parse(raw) : [];

      if (user.id) {
        // Update existing
        const idx = users.findIndex(u => u.id === user.id);
        if (idx >= 0) {
          users[idx] = { ...users[idx], ...user };
        } else {
          users.push(user);
        }
      } else {
        // New user
        user.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        user.active = true;
        users.push(user);
      }

      await getCommStore().set('users', JSON.stringify(users));
      return { statusCode: 200, headers: H, body: JSON.stringify({ success: true, userId: user.id }) };
    }

    // DELETE user
    if (event.httpMethod === 'DELETE' && action === 'deleteUser') {
      const { userId } = body;
      if (!userId) return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'Missing userId' }) };
      let raw = null;
      try { raw = await getCommStore().get('users'); } catch(e) {}
      let users = raw ? JSON.parse(raw) : [];
      users = users.filter(u => u.id !== userId);
      await getCommStore().set('users', JSON.stringify(users));
      return { statusCode: 200, headers: H, body: JSON.stringify({ success: true }) };
    }


    // GET payouts list
    if (event.httpMethod === 'GET' && action === 'payouts') {
      let raw = null;
      try { raw = await getCommStore().get('payouts'); } catch(e) {}
      const payouts = raw ? JSON.parse(raw) : [];
      // If repId filter passed, filter to that rep
      const repId = (event.queryStringParameters || {}).repId;
      return { statusCode: 200, headers: H, body: JSON.stringify({
        payouts: repId ? payouts.filter(p => p.repId === repId) : payouts
      })};
    }

    // POST record a payout
    if (event.httpMethod === 'POST' && action === 'recordPayout') {
      const { payout } = body;
      if (!payout || !payout.repId || !payout.amount || !payout.month) {
        return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'repId, amount, month required' }) };
      }
      let raw = null;
      try { raw = await getCommStore().get('payouts'); } catch(e) {}
      let payouts = raw ? JSON.parse(raw) : [];
      // Check for duplicate payout this month for this rep
      const existing = payouts.find(p => p.repId === payout.repId && p.month === payout.month);
      if (existing) {
        return { statusCode: 409, headers: H, body: JSON.stringify({ 
          error: 'Payout already recorded for ' + payout.repName + ' for ' + payout.month 
        })};
      }
      payout.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      payout.paidDate = new Date().toISOString();
      payouts.push(payout);
      await getCommStore().set('payouts', JSON.stringify(payouts));
      return { statusCode: 200, headers: H, body: JSON.stringify({ success: true, payoutId: payout.id }) };
    }

    // DELETE / void a payout
    if (event.httpMethod === 'DELETE' && action === 'voidPayout') {
      const { payoutId } = body;
      if (!payoutId) return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'Missing payoutId' }) };
      let raw = null;
      try { raw = await getCommStore().get('payouts'); } catch(e) {}
      let payouts = raw ? JSON.parse(raw) : [];
      const idx = payouts.findIndex(p => p.id === payoutId);
      if (idx === -1) return { statusCode: 404, headers: H, body: JSON.stringify({ error: 'Payout not found' }) };
      payouts[idx].voided = true;
      payouts[idx].voidedDate = new Date().toISOString();
      await getCommStore().set('payouts', JSON.stringify(payouts));
      return { statusCode: 200, headers: H, body: JSON.stringify({ success: true }) };
    }

    return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'Unknown action: ' + action }) };

  } catch (err) {
    console.error('commission.js error:', err.message);
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: err.message }) };
  }
};
