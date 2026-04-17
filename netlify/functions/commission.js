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

  function store() { return getStore({ name: 'commission', consistency: 'strong' }); }
  async function blobGet(k) { try { return await store().get(k); } catch(e) { return null; } }
  async function blobSet(k, v) { try { await store().set(k, v); return true; } catch(e) { return false; } }

  // Helper: authenticate a rep by password, return user object or null
  async function authRep() {
    const pw = (event.headers && (event.headers['x-user-password'] || event.headers['X-User-Password'])) || '';
    if (!pw) return null;
    const raw = await blobGet('users');
    const users = raw ? JSON.parse(raw) : [];
    return users.find(u => u.active && u.password === pw) || null;
  }

  try {
    // ── LOGIN ────────────────────────────────────────
    if (action === 'login') {
      const pw = body.password || '';
      if (adminPw && pw === adminPw) return { statusCode: 200, headers: H, body: JSON.stringify({ role: 'admin', name: 'Admin' }) };
      const raw = await blobGet('users');
      const users = raw ? JSON.parse(raw) : [];
      const user = users.find(u => u.active && u.password === pw);
      if (user) return { statusCode: 200, headers: H, body: JSON.stringify({ role: 'rep', name: user.name, employeeId: user.buildopsEmployeeId, userId: user.id }) };
      return { statusCode: 401, headers: H, body: JSON.stringify({ error: 'Invalid password' }) };
    }

    // ── PUBLIC: cached data ──────────────────────────
    if (event.httpMethod === 'GET' && action === 'data') {
      const key = qs.key || '';
      if (!key) return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'Missing key' }) };
      const raw = await blobGet('data:' + key);
      if (!raw) return { statusCode: 200, headers: H, body: JSON.stringify({ items: [], cached: false }) };
      try { return { statusCode: 200, headers: H, body: JSON.stringify({ items: JSON.parse(raw), cached: true }) }; }
      catch { return { statusCode: 200, headers: H, body: JSON.stringify({ value: raw, cached: true }) }; }
    }

    // ── PUBLIC: sync status ──────────────────────────
    if (event.httpMethod === 'GET' && action === 'syncStatus') {
      const syncedAt = await blobGet('data:syncedAt');
      const errRaw = await blobGet('data:syncErrors');
      return { statusCode: 200, headers: H, body: JSON.stringify({ syncedAt, errors: errRaw ? JSON.parse(errRaw) : {} }) };
    }

    // ── PUBLIC: rates ────────────────────────────────
    if (event.httpMethod === 'GET' && action === 'rates') {
      const raw = await blobGet('rates');
      return { statusCode: 200, headers: H, body: JSON.stringify({ rates: raw ? JSON.parse(raw) : { house: 3, rep: 5, none: 5, cbDays: 90 } }) };
    }

    // ── PAYOUTS (admin=all, rep=own) ─────────────────
    if (event.httpMethod === 'GET' && action === 'payouts') {
      const raw = await blobGet('payouts');
      let payouts = raw ? JSON.parse(raw) : [];
      payouts = payouts.filter(p => !p.voided);
      if (!isAdmin) {
        const user = await authRep();
        if (!user) return { statusCode: 403, headers: H, body: JSON.stringify({ error: 'Auth required' }) };
        payouts = payouts.filter(p => p.repId === user.buildopsEmployeeId);
      } else if (qs.repId) {
        payouts = payouts.filter(p => p.repId === qs.repId);
      }
      return { statusCode: 200, headers: H, body: JSON.stringify({ payouts }) };
    }

    // ── REVIEWS (admin=all, rep=own) ─────────────────
    if (event.httpMethod === 'GET' && action === 'reviews') {
      const raw = await blobGet('reviews');
      let reviews = raw ? JSON.parse(raw) : [];
      if (!isAdmin) {
        const user = await authRep();
        if (!user) return { statusCode: 403, headers: H, body: JSON.stringify({ error: 'Auth required' }) };
        reviews = reviews.filter(r => r.repId === user.buildopsEmployeeId);
      }
      return { statusCode: 200, headers: H, body: JSON.stringify({ reviews }) };
    }

    // ── DISPUTES (admin=all, rep=own) ────────────────
    if (event.httpMethod === 'GET' && action === 'disputes') {
      const raw = await blobGet('disputes');
      let disputes = raw ? JSON.parse(raw) : [];
      if (!isAdmin) {
        const user = await authRep();
        if (!user) return { statusCode: 403, headers: H, body: JSON.stringify({ error: 'Auth required' }) };
        disputes = disputes.filter(d => d.repId === user.buildopsEmployeeId);
      }
      return { statusCode: 200, headers: H, body: JSON.stringify({ disputes }) };
    }

    // ── REP: acknowledge month ───────────────────────
    if (event.httpMethod === 'POST' && action === 'repAcknowledge') {
      const user = await authRep();
      if (!user) return { statusCode: 403, headers: H, body: JSON.stringify({ error: 'Auth required' }) };
      const { month } = body;
      if (!month) return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'month required' }) };
      const raw = await blobGet('reviews');
      let reviews = raw ? JSON.parse(raw) : [];
      let review = reviews.find(r => r.repId === user.buildopsEmployeeId && r.month === month);
      if (review) {
        review.repAcknowledged = true;
        review.repAcknowledgedDate = new Date().toISOString();
      } else {
        reviews.push({
          id: Date.now().toString(36) + Math.random().toString(36).slice(2,5),
          repId: user.buildopsEmployeeId, repName: user.name,
          month, status: 'acknowledged',
          repAcknowledged: true, repAcknowledgedDate: new Date().toISOString(),
        });
      }
      await blobSet('reviews', JSON.stringify(reviews));
      return { statusCode: 200, headers: H, body: JSON.stringify({ success: true }) };
    }

    // ── REP: submit dispute ──────────────────────────
    if (event.httpMethod === 'POST' && action === 'submitDispute') {
      const user = await authRep();
      if (!user) return { statusCode: 403, headers: H, body: JSON.stringify({ error: 'Auth required' }) };
      const { jobId, jobNumber, invoiceNumber, note } = body;
      if (!jobId || !note) return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'jobId and note required' }) };
      const raw = await blobGet('disputes');
      let disputes = raw ? JSON.parse(raw) : [];
      disputes.push({
        id: Date.now().toString(36) + Math.random().toString(36).slice(2,5),
        repId: user.buildopsEmployeeId, repName: user.name,
        jobId, jobNumber: jobNumber || '', invoiceNumber: invoiceNumber || '',
        note, status: 'open', createdDate: new Date().toISOString(),
      });
      await blobSet('disputes', JSON.stringify(disputes));
      return { statusCode: 200, headers: H, body: JSON.stringify({ success: true }) };
    }

    // ══ ADMIN ONLY below ═════════════════════════════
    if (!isAdmin) return { statusCode: 403, headers: H, body: JSON.stringify({ error: 'Admin access required' }) };

    // ── GET users ────────────────────────────────────
    if (event.httpMethod === 'GET' && action === 'users') {
      const raw = await blobGet('users');
      const users = raw ? JSON.parse(raw) : [];
      return { statusCode: 200, headers: H, body: JSON.stringify({ users: users.map(u => ({ ...u, password: '••••••' })) }) };
    }

    // ── POST saveRates ───────────────────────────────
    if (event.httpMethod === 'POST' && action === 'saveRates') {
      if (!body.rates) return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'Missing rates' }) };
      const r = body.rates;
      const normalized = { house: parseFloat(r.house)||3, rep: parseFloat(r.rep)||5, none: parseFloat(r.none)||5, cbDays: parseInt(r.cbDays||r.clawbackDays)||90 };
      await blobSet('rates', JSON.stringify(normalized));
      return { statusCode: 200, headers: H, body: JSON.stringify({ success: true, rates: normalized }) };
    }

    // ── POST saveUser ────────────────────────────────
    if (event.httpMethod === 'POST' && action === 'saveUser') {
      const user = body.user;
      if (!user || !user.name || (!user.id && !user.password)) return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'name and password required' }) };
      const raw = await blobGet('users'); let users = raw ? JSON.parse(raw) : [];
      if (user.id) {
        const idx = users.findIndex(u => u.id === user.id);
        if (idx >= 0) { if (!user.password || user.password === '••••••') user.password = users[idx].password; users[idx] = { ...users[idx], ...user }; }
        else users.push(user);
      } else { user.id = Date.now().toString(36) + Math.random().toString(36).slice(2,6); user.active = true; users.push(user); }
      await blobSet('users', JSON.stringify(users));
      return { statusCode: 200, headers: H, body: JSON.stringify({ success: true, userId: user.id }) };
    }

    // ── DELETE user ──────────────────────────────────
    if (event.httpMethod === 'DELETE' && action === 'deleteUser') {
      if (!body.userId) return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'Missing userId' }) };
      const raw = await blobGet('users'); let users = raw ? JSON.parse(raw) : [];
      users = users.filter(u => u.id !== body.userId);
      await blobSet('users', JSON.stringify(users));
      return { statusCode: 200, headers: H, body: JSON.stringify({ success: true }) };
    }

    // ── POST submitReview (accounting workflow) ──────
    if (event.httpMethod === 'POST' && action === 'submitReview') {
      const { repId, repName, month, monthLabel, totalCommission, invoiceCount, invoiceNums } = body;
      if (!repId || !month) return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'repId and month required' }) };
      const raw = await blobGet('reviews'); let reviews = raw ? JSON.parse(raw) : [];
      let existing = reviews.find(r => r.repId === repId && r.month === month);
      if (existing && existing.status === 'approved') return { statusCode: 409, headers: H, body: JSON.stringify({ error: 'Already approved' }) };
      if (existing) {
        existing.status = 'pending';
        existing.totalCommission = totalCommission;
        existing.invoiceCount = invoiceCount;
        existing.invoiceNums = invoiceNums;
        existing.submittedDate = new Date().toISOString();
      } else {
        reviews.push({
          id: Date.now().toString(36) + Math.random().toString(36).slice(2,5),
          repId, repName: repName || repId, month, monthLabel: monthLabel || month,
          totalCommission: totalCommission || 0, invoiceCount: invoiceCount || 0,
          invoiceNums: invoiceNums || [],
          status: 'pending', submittedDate: new Date().toISOString(),
          repAcknowledged: false,
        });
      }
      await blobSet('reviews', JSON.stringify(reviews));
      return { statusCode: 200, headers: H, body: JSON.stringify({ success: true }) };
    }

    // ── POST approveReview ───────────────────────────
    if (event.httpMethod === 'POST' && action === 'approveReview') {
      if (!body.reviewId) return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'Missing reviewId' }) };
      const raw = await blobGet('reviews'); let reviews = raw ? JSON.parse(raw) : [];
      const r = reviews.find(r => r.id === body.reviewId);
      if (!r) return { statusCode: 404, headers: H, body: JSON.stringify({ error: 'Review not found' }) };
      r.status = 'approved';
      r.approvedDate = new Date().toISOString();
      r.approvedBy = body.approvedBy || 'Admin';
      r.approvalNote = body.note || '';
      await blobSet('reviews', JSON.stringify(reviews));
      return { statusCode: 200, headers: H, body: JSON.stringify({ success: true }) };
    }

    // ── POST rejectReview ────────────────────────────
    if (event.httpMethod === 'POST' && action === 'rejectReview') {
      if (!body.reviewId) return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'Missing reviewId' }) };
      const raw = await blobGet('reviews'); let reviews = raw ? JSON.parse(raw) : [];
      const r = reviews.find(r => r.id === body.reviewId);
      if (!r) return { statusCode: 404, headers: H, body: JSON.stringify({ error: 'Review not found' }) };
      r.status = 'rejected';
      r.rejectedDate = new Date().toISOString();
      r.rejectionNote = body.note || '';
      await blobSet('reviews', JSON.stringify(reviews));
      return { statusCode: 200, headers: H, body: JSON.stringify({ success: true }) };
    }

    // ── POST resolveDispute ──────────────────────────
    if (event.httpMethod === 'POST' && action === 'resolveDispute') {
      if (!body.disputeId) return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'Missing disputeId' }) };
      const raw = await blobGet('disputes'); let disputes = raw ? JSON.parse(raw) : [];
      const d = disputes.find(d => d.id === body.disputeId);
      if (!d) return { statusCode: 404, headers: H, body: JSON.stringify({ error: 'Dispute not found' }) };
      d.status = 'resolved';
      d.resolvedDate = new Date().toISOString();
      d.resolution = body.resolution || '';
      await blobSet('disputes', JSON.stringify(disputes));
      return { statusCode: 200, headers: H, body: JSON.stringify({ success: true }) };
    }

    // ── POST recordPayout ────────────────────────────
    if (event.httpMethod === 'POST' && action === 'recordPayout') {
      const payout = body.payout;
      if (!payout || !payout.repId || !payout.amount || !payout.month) return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'repId, amount, month required' }) };
      // Check if review is approved
      const revRaw = await blobGet('reviews'); const reviews = revRaw ? JSON.parse(revRaw) : [];
      const review = reviews.find(r => r.repId === payout.repId && r.month === payout.month);
      if (!review || review.status !== 'approved') {
        return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'Commission must be approved by accounting before payout. Submit for review first.' }) };
      }
      const raw = await blobGet('payouts'); let payouts = raw ? JSON.parse(raw) : [];
      if (payouts.find(p => p.repId === payout.repId && p.month === payout.month && !p.voided)) {
        return { statusCode: 409, headers: H, body: JSON.stringify({ error: 'Payout already recorded for ' + payout.repName + ' for ' + payout.month }) };
      }
      payout.id = Date.now().toString(36) + Math.random().toString(36).slice(2,5);
      payout.paidDate = new Date().toISOString();
      payouts.push(payout);
      await blobSet('payouts', JSON.stringify(payouts));
      // Update review status to paid
      review.status = 'paid'; review.paidDate = payout.paidDate;
      await blobSet('reviews', JSON.stringify(reviews));
      return { statusCode: 200, headers: H, body: JSON.stringify({ success: true, payoutId: payout.id }) };
    }

    // ── DELETE voidPayout ─────────────────────────────
    if (event.httpMethod === 'DELETE' && action === 'voidPayout') {
      if (!body.payoutId) return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'Missing payoutId' }) };
      const raw = await blobGet('payouts'); let payouts = raw ? JSON.parse(raw) : [];
      const idx = payouts.findIndex(p => p.id === body.payoutId);
      if (idx === -1) return { statusCode: 404, headers: H, body: JSON.stringify({ error: 'Payout not found' }) };
      payouts[idx].voided = true; payouts[idx].voidedDate = new Date().toISOString();
      await blobSet('payouts', JSON.stringify(payouts));
      // Revert review status to approved
      const revRaw = await blobGet('reviews'); let reviews = revRaw ? JSON.parse(revRaw) : [];
      const rev = reviews.find(r => r.repId === payouts[idx].repId && r.month === payouts[idx].month);
      if (rev) { rev.status = 'approved'; delete rev.paidDate; await blobSet('reviews', JSON.stringify(reviews)); }
      return { statusCode: 200, headers: H, body: JSON.stringify({ success: true }) };
    }

    return { statusCode: 400, headers: H, body: JSON.stringify({ error: 'Unknown action: ' + action }) };
  } catch (err) {
    console.error('commission.js error:', err.message);
    return { statusCode: 500, headers: H, body: JSON.stringify({ error: err.message }) };
  }
};
