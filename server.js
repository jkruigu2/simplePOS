require('dotenv').config();
// Only needed on devices whose DNS can't look up Atlas (querySrv EBADRESP, e.g. Termux): set DNS_SERVERS=8.8.8.8,1.1.1.1 in .env
if (process.env.DNS_SERVERS) require('dns').setServers(process.env.DNS_SERVERS.split(',').map(x => x.trim()));
const express = require('express'), mongoose = require('mongoose'), bcrypt = require('bcryptjs'),
      jwt = require('jsonwebtoken'), path = require('path'), crypto = require('crypto');
const T = require('./lib/transfer');
const SECRET = process.env.JWT_SECRET;

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- models ----------
const M = (n, f = {}) => mongoose.model(n, new mongoose.Schema(
  { co: { type: String, index: true }, id: String, ...f }, { strict: false, versionKey: false, id: false }));
const Company = mongoose.model('Company', new mongoose.Schema(
  { code: { type: String, unique: true }, name: String, loc: String, motto: String, phone: String, cur: String, fields: { type: Array, default: [] }, v: { type: Object, default: {} }, rcpt: { type: Object, default: {} }, rh: String, renc: String, sub: { type: Object }, created: Number }, { versionKey: false }));
const User = M('User', { user: String, name: String, role: String, h: String });
const Branch = M('Branch', { name: String, loc: String });
const Cat = M('Cat'), Prod = M('Prod'), Sale = M('Sale'), Expense = M('Expense'), Move = M('Move'), Log = M('Log'), Refund = M('Refund'), Lay = M('Lay'), Ledger = M('Ledger'), Cust = M('Cust'), Trf = M('Trf'), Counter = M('Counter'), Trash = M('Trash'), Photo = M('Photo');
const DATA = [Cat, Prod, Sale, Expense, Move, Log, Refund, Lay, Ledger];   // everything that belongs to one branch (has a `br` field)

// ---------- helpers ----------
const uniq = a => { const s = new Set(); return a.filter(x => x && !s.has(x.id) && s.add(x.id)); };   // never show the same record twice
async function insertOnce(Mo, docs) {   // a record that already exists (same company and id) is left alone, so repeated or overlapping requests cannot create copies
  if (!docs.length) return;
  try { await Mo.bulkWrite(docs.map(d => { const { co, id, ...rest } = d; return { updateOne: { filter: { co, id }, update: { $setOnInsert: rest }, upsert: true } }; }), { ordered: false }); }
  catch (e) { if (!(e.code === 11000 || /E11000/.test(String(e.message)))) throw e; }   // a duplicate-key refusal means another request saved it first: fine
}
const ROLES = ['admin', 'manager', 'cashier'];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const fail = (c, m) => { const e = new Error(m); e.status = c; throw e; };
const wrap = f => (q, s) => f(q, s).catch(e => s.status(e.status || 500).json({ error: e.message || 'Server error' }));
const rcode = () => [...crypto.randomBytes(12)].map(b => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('').replace(/(.{4})(?=.)/g, '$1-');
// The recovery code is kept encrypted (not just hashed) so the admin can look at it again after typing their password.
const RK = () => crypto.createHash('sha256').update('rc:' + SECRET).digest();
const encCode = c => { const iv = crypto.randomBytes(12), k = crypto.createCipheriv('aes-256-gcm', RK(), iv), e = Buffer.concat([k.update(c, 'utf8'), k.final()]); return [iv, k.getAuthTag(), e].map(b => b.toString('base64')).join('.'); };
const decCode = x => { try { const [iv, tag, e] = String(x).split('.').map(b => Buffer.from(b, 'base64')), k = crypto.createDecipheriv('aes-256-gcm', RK(), iv); k.setAuthTag(tag); return Buffer.concat([k.update(e), k.final()]).toString('utf8'); } catch (e) { return null; } };
const tok = u => jwt.sign({ uid: u.id }, SECRET, { expiresIn: '7d' });
const pub = u => ({ id: u.id, co: u.co, user: u.user, name: u.name, role: u.role, br: u.br || [] });
// Branch access: admins see every branch; managers and cashiers only the branches assigned to them.
const scope = q => q.u.role === 'admin' ? { co: q.u.co } : { co: q.u.co, br: { $in: q.u.br || [] } };
// Transfers are visible to people at the sending branch and at the receiving branch.
const tScope = q => q.u.role === 'admin' ? { co: q.u.co } : { co: q.u.co, $or: [{ from: { $in: q.u.br || [] } }, { to: { $in: q.u.br || [] } }] };
const okBr = (q, b) => !!b && (q.u.role === 'admin' || (q.u.br || []).includes(b));
const clean = (a, q) => { if (!Array.isArray(a) || a.length > 20000) fail(400, 'Bad data'); return a.filter(x => x && x.id && okBr(q, x.br)).map(x => ({ ...x, co: q.u.co })); };
const newBranch = async (co, name, loc = '', id = uid()) => { await Branch.updateOne({ co, id }, { $setOnInsert: { co, id, name, loc } }, { upsert: true }); return { id, co, name, loc }; };
async function ensureBranch(co) {   // companies created before branches existed get one branch ("Main") that owns all their data
  if (await Branch.countDocuments({ co })) return;
  await newBranch(co, 'Main', '', 'main');
  for (const Mo of DATA) await Mo.updateMany({ co, br: { $exists: false } }, { $set: { br: 'main' } });
  await User.updateMany({ co, role: { $ne: 'admin' }, br: { $exists: false } }, { $set: { br: ['main'] } });
}
// ---------- subscriptions ----------
const SUBCFG = () => ({ trial: Math.max(0, parseInt(process.env.SUB_TRIAL_DAYS) || 14), grace: Math.max(0, parseInt(process.env.SUB_GRACE_DAYS) || 3) });
function subInfo(c) {   // active (paid up), grace (just expired: still works, with a warning), expired or suspended (blocked)
  const g = SUBCFG().grace, s = (c && c.sub) || {};
  const base = { plan: s.plan || 'legacy', until: s.until || null, grace: g, contact: process.env.OWNER_CONTACT || '', note: s.note || '' };
  if (s.status === 'suspended') return { ...base, state: 'suspended', days: null };
  if (!s.until) return { ...base, state: 'active', days: null };   // companies without an end date (older companies) are not blocked
  const days = Math.ceil((s.until - Date.now()) / 864e5);
  return { ...base, state: days > 0 ? 'active' : -days < g ? 'grace' : 'expired', days };
}
const subCache = {};
async function subOf(co) {   // remembered for a minute so every request does not hit the database
  const c = subCache[co];
  if (c && Date.now() - c.t < 60000) return c.i;
  const i = subInfo(await Company.findOne({ code: co }).select('sub').lean());
  subCache[co] = { t: Date.now(), i }; return i;
}
async function auth(q, s, n) {
  try {
    const p = jwt.verify((q.headers.authorization || '').slice(7), SECRET);
    const u = await User.findOne({ id: p.uid }).lean();   // role and branches are read fresh on every request
    if (!u) throw 0;
    q.u = u; q.sub = await subOf(u.co);
    if (!q.noSub && !['active', 'grace'].includes(q.sub.state))
      return s.status(402).json({ error: q.sub.state === 'suspended' ? 'This account has been suspended.' : 'Your subscription has expired.', code: 'SUB_EXPIRED', sub: q.sub, contact: q.sub.contact });
    n();
  } catch (e) { s.status(401).json({ error: 'Please log in again' }); }
}
const authNoSub = (q, s, n) => { q.noSub = true; return auth(q, s, n); };
const need = (...r) => (q, s, n) => r.includes(q.u.role) ? n() : s.status(403).json({ error: 'Not allowed for your role' });
const TKIND = { Cat: 'cat', Prod: 'product', Expense: 'expense', Sale: 'receipt' };
const tLabel = (n, d) => n === 'Prod' ? String(d.name || 'Product') : n === 'Cat' ? String(d.name || 'Category') : n === 'Expense' ? String(d.cat || 'Expense') + ' · ' + (d.amt || 0) : 'Receipt #' + (d.no || '') + ' · ' + (d.total || 0);
async function trashPut(q, Mo, docs) {   // nothing is thrown away at once: it waits in the trash for 30 days
  if (!docs.length) return;
  const at = Date.now();
  await Trash.insertMany(docs.slice(0, 2000).map(({ _id, ...d }) => ({ id: uid(), co: q.u.co, br: d.br || '', kind: TKIND[Mo.modelName], label: tLabel(Mo.modelName, d), doc: d, by: q.u.name, at, expireAt: new Date(at + 30 * 864e5) })), { ordered: false }).catch(() => {});
}
const replaceAll = async (Mo, q, a) => {
  try { await trashPut(q, Mo, await Mo.find({ ...scope(q), id: { $nin: a.map(x => x.id) } }).lean()); } catch (e) {}
  return Mo.bulkWrite([
  { deleteMany: { filter: { ...scope(q), id: { $nin: a.map(x => x.id) } } } },
  ...a.map(x => ({ replaceOne: { filter: { co: q.u.co, id: x.id }, replacement: x, upsert: true } }))]);
};

// ---------- change counters (devices poll /api/ver and only fetch what changed) ----------
const VKEY = { '/api/sales': 'sales', '/api/moves': 'moves', '/api/logs': 'logs', '/api/rets': 'rets', '/api/prods': 'prods', '/api/cats': 'cats', '/api/expenses': 'expenses', '/api/custs': 'custs', '/api/lays': 'lays', '/api/ledger': 'ledger' };
app.use('/api', (q, s, n) => {
  if (q.method !== 'GET') {
    const p = '/api' + q.path, m = q.method;
    s.on('finish', () => {
      if (s.statusCode >= 400 || !q.u) return;
      let ks = [];
      if (m === 'PUT' && VKEY[p]) ks = [VKEY[p]];
      else if (p.startsWith('/api/sales/')) ks = ['salesx'];
      else if (p.startsWith('/api/trash')) ks = ['prods', 'cats', 'expenses', 'salesx'];
      else if (p.startsWith('/api/photo/')) ks = ['photos'];
      else if (p.startsWith('/api/dupes')) ks = ['salesx'];
      else if (p.startsWith('/api/transfers')) ks = ['prods', 'cats', 'trf', 'moves'];
      else if (p === '/api/restore') ks = ['org', 'salesx', 'prods', 'cats', 'expenses', 'moves', 'logs', 'rets', 'custs', 'lays', 'ledger'];
      else if (p !== '/api/recovery/show' && /^\/api\/(users|branches|company|password|recovery)/.test(p)) ks = ['org'];
      if (ks.length) Company.updateOne({ code: q.u.co }, { $inc: Object.fromEntries(ks.map(k => ['v.' + k, 1])) }).catch(() => {});
    });
  }
  n();
});

// ---------- health check ----------
app.get('/api/health', wrap(async (q, s) => {
  if (mongoose.connection.readyState !== 1) fail(503, 'Database not connected');
  await mongoose.connection.db.admin().ping();
  s.json({ server: 'ok', database: 'connected' });
}));

// ---------- auth ----------
app.post('/api/register', wrap(async (q, s) => {
  if (String(process.env.ALLOW_SIGNUP || 'true').toLowerCase() === 'false') fail(403, 'New company registration is closed. Please contact ' + (process.env.OWNER_CONTACT || 'the owner') + '.');
  const d = q.body, code = String(d.code || '').trim().toUpperCase(), user = String(d.user || '').trim().toLowerCase();
  if (!code || !user || !d.name || !d.pass || String(d.pass).length < 4) fail(400, 'Fill in all fields (password min 4 characters).');
  if (await Company.findOne({ code })) fail(409, 'That company code is already in use.');
  const recovery = rcode();
  await Company.create({ code, name: String(d.name).trim(), loc: d.loc, motto: d.motto, phone: d.phone, rh: await bcrypt.hash(recovery, 10), renc: encCode(recovery), created: Date.now(), sub: { plan: 'trial', status: 'active', until: Date.now() + SUBCFG().trial * 864e5 } });
  await newBranch(code, 'Main', '', 'main');
  const u = await User.create({ id: uid(), co: code, user, name: String(d.user).trim(), role: 'admin', br: [], h: await bcrypt.hash(String(d.pass), 10) });
  s.json({ token: tok(u), recovery });
}));
app.post('/api/login', wrap(async (q, s) => {
  const d = q.body;
  const u = await User.findOne({ co: String(d.code || '').trim().toUpperCase(), user: String(d.user || '').trim().toLowerCase() });
  if (!u || !(await bcrypt.compare(String(d.pass || ''), u.h))) fail(401, 'Invalid company code, username or password.');
  s.json({ token: tok(u) });
}));

// ---------- data ----------
app.get('/api/data', auth, wrap(async (q, s) => {
  const now = Date.now();
  await ensureBranch(q.u.co);
  q.u = await User.findOne({ id: q.u.id }).lean();
  const days = Math.min(Math.max(parseInt(q.query.days) || 35, 1), 3650), cut = now - days * 864e5;   // only recent sales are sent; older ones load on request
  const r = q.u.role, mgr = r !== 'cashier', adm = r === 'admin';
  const L = (m, flt = {}, lim, sort) => { let c = m.find({ ...scope(q), ...flt }).select('-_id'); if (sort) c = c.sort(sort); if (lim) c = c.limit(lim); return c.lean(); };
  const [company, users, branches, cats, prods, sales, expenses, rets, moves, logs, custs, lays, bl, trf, bn] = await Promise.all([
    Company.findOne({ code: q.u.co })  .select('-_id -rh -renc').lean(), User.find({ co: q.u.co }).select('-_id -h').lean(),
    Branch.find(adm ? { co: q.u.co } : { co: q.u.co, id: { $in: q.u.br || [] } }).select('-_id').lean(),
    L(Cat), L(Prod), L(Sale, { ts: { $gte: cut } }, 5000, { ts: -1 }),
    mgr ? L(Expense, { ts: { $gte: cut } }) : [], mgr ? L(Refund, { ts: { $gte: cut } }) : [],
    mgr ? L(Move, {}, 500, { ts: -1 }) : [], adm ? L(Log, {}, 500, { ts: -1 }) : [],
    Cust.find({ co: q.u.co }).select('-_id').lean(), L(Lay, { $or: [{ status: 'open' }, { ts: { $gte: cut } }] }), Ledger.aggregate([{ $match: { co: q.u.co } }, { $group: { _id: '$id', cid: { $first: '$cid' }, amt: { $first: '$amt' } } }, { $group: { _id: '$cid', bal: { $sum: '$amt' } } }]),
    Trf.find({ $and: [tScope(q), { $or: [{ status: 'pending' }, { ts: { $gte: cut } }] }] }).select('-_id').lean(), Branch.find({ co: q.u.co }).select('-_id id name').lean()]);
  const bals = Object.fromEntries(bl.map(x => [x._id, Math.round(x.bal * 100) / 100]));
  const win = sales.length >= 5000 ? Math.min(...sales.map(x => x.ts)) : cut;
  s.json({ company, users, branches, cats, prods, sales: uniq(sales), expenses: uniq(expenses), rets: uniq(rets), moves: uniq(moves), logs: uniq(logs), custs, lays: uniq(lays), bals, trf, bnames: bn, subinfo: subInfo(company), me: q.u.id, v: (company && company.v) || {}, now, win });
}));
app.get('/api/ver', auth, wrap(async (q, s) => {   // tiny: lets a device check whether anything changed
  const c = await Company.findOne({ code: q.u.co }).select('v -_id').lean(); s.json({ v: (c && c.v) || {} });
}));
app.get('/api/range', auth, wrap(async (q, s) => {   // older sales, refunds and expenses on request
  const f = { ...scope(q), ts: { $gte: Number(q.query.from) || 0, $lt: Number(q.query.to) || Date.now() } }, mgr = q.u.role !== 'cashier';
  const [sales, rets, expenses] = await Promise.all([Sale.find(f).select('-_id').sort({ ts: -1 }).limit(20000).lean(), mgr ? Refund.find(f).select('-_id').lean() : [], mgr ? Expense.find(f).select('-_id').lean() : []]);
  s.json({ sales: uniq(sales), rets: uniq(rets), expenses: uniq(expenses), truncated: sales.length >= 20000 });
}));
const DELTA = { trf: [Trf, 'c'], lays: [Lay, 'c'], custs: [Cust, 'c'], sales: [Sale, 'c'], moves: [Move, 'm'], logs: [Log, 'a'], rets: [Refund, 'm'] };
app.get('/api/delta/:c', auth, wrap(async (q, s) => {   // only records added since the last check
  const now = Date.now(), d = DELTA[q.params.c], r = q.u.role;
  if (!d) fail(404, 'Unknown collection');
  if ((d[1] === 'm' && r === 'cashier') || (d[1] === 'a' && r !== 'admin')) return s.json({ docs: [], now });
  const docs = await d[0].find({ ...(q.params.c === 'custs' ? { co: q.u.co } : q.params.c === 'trf' ? tScope(q) : scope(q)), at: { $gt: Number(q.query.after) || 0 } }).select('-_id').sort({ at: 1 }).limit(3000).lean();
  s.json({ docs: uniq(docs), now, more: docs.length >= 3000, last: docs.length ? docs[docs.length - 1].at : 0 });
}));
const COL2 = { prods: Prod, cats: Cat, expenses: Expense };
app.get('/api/col/:c', auth, wrap(async (q, s) => {   // one whole collection (products, categories, expenses)
  const now = Date.now(), m = COL2[q.params.c];
  if (!m) fail(404, 'Unknown collection');
  if (q.params.c === 'expenses' && q.u.role === 'cashier') return s.json({ docs: [], now });
  const f = { ...scope(q) }; if (q.params.c === 'expenses') f.ts = { $gte: Number(q.query.from) || 0 };
  s.json({ docs: await m.find(f).select('-_id').lean(), now });
}));
app.get('/api/series', auth, need('admin', 'manager'), wrap(async (q, s) => {   // sales, expenses and stock movements per week / month / year (for the stock report graphs)
  const unit = ['week', 'month', 'year'].includes(q.query.bucket) ? q.query.bucket : 'month', tz = String(q.query.tz || 'UTC');
  const f = { ...scope(q) }, rng = { ts: { $gte: Number(q.query.from) || 0, $lt: Number(q.query.to) || Date.now() + 1 } };
  if (q.query.br && q.query.br !== 'all') { if (!okBr(q, q.query.br)) fail(403, 'Not allowed'); f.br = q.query.br; }
  const bk = d => ({ $toLong: { $dateTrunc: { date: { $toDate: d }, unit, timezone: tz, startOfWeek: 'monday' } } });
  let sales, exp, flow, first;
  try {
    [sales, exp, flow, first] = await Promise.all([
      Sale.aggregate([{ $match: { ...f, ...rng } }, { $group: { _id: '$id', ts: { $first: '$ts' }, total: { $first: '$total' }, profit: { $first: '$profit' } } }, { $group: { _id: bk('$ts'), n: { $sum: 1 }, rev: { $sum: '$total' }, profit: { $sum: '$profit' } } }]),
      Expense.aggregate([{ $match: { ...f, ...rng } }, { $group: { _id: bk('$ts'), amt: { $sum: '$amt' } } }]),
      Move.aggregate([{ $match: { ...f, ...rng } }, { $group: { _id: '$id', ts: { $first: '$ts' }, pid: { $first: '$pid' }, qty: { $first: '$qty' } } }, { $group: { _id: { b: bk('$ts'), pid: '$pid' }, d: { $sum: '$qty' } } }]),
      Move.find(f).sort({ ts: 1 }).limit(1).select('ts').lean()]);
  } catch (e) { fail(400, 'Could not work out the trend.'); }
  s.json({ sales: sales.map(x => ({ b: x._id, n: x.n, rev: x.rev, profit: x.profit })), exp: exp.map(x => ({ b: x._id, amt: x.amt })), flow: flow.map(x => ({ b: x._id.b, pid: x._id.pid, d: x.d })), firstMove: first.length ? first[0].ts : null });
}));
app.get('/api/monthly', auth, need('admin', 'manager'), wrap(async (q, s) => {   // sales totals per month, worked out by the database
  const match = { ...scope(q), ts: { $gte: Number(q.query.from), $lt: Number(q.query.to) } };
  if (q.query.br && q.query.br !== 'all') { if (!okBr(q, q.query.br)) fail(403, 'Not allowed'); match.br = q.query.br; }
  let rows;
  try { rows = await Sale.aggregate([{ $match: match }, { $group: { _id: '$id', ts: { $first: '$ts' }, total: { $first: '$total' }, profit: { $first: '$profit' } } }, { $group: { _id: { $month: { date: { $toDate: '$ts' }, timezone: String(q.query.tz || 'UTC') } }, n: { $sum: 1 }, rev: { $sum: '$total' }, profit: { $sum: '$profit' } } }]); }
  catch (e) { fail(400, 'Could not total the months'); }
  s.json({ months: rows.map(r => ({ m: r._id - 1, n: r.n, rev: r.rev, profit: r.profit })) });
}));
app.put('/api/cats', auth, need('admin', 'manager'), wrap(async (q, s) => {
  await replaceAll(Cat, q, clean(q.body, q)); s.json({ ok: 1 });
}));
app.put('/api/prods', auth, wrap(async (q, s) => {
  const co = q.u.co, a = clean(q.body, q);
  if (q.u.role === 'cashier') {            // cashiers may only change stock levels
    if (a.length) await Prod.bulkWrite(a.map(x => ({ updateOne: { filter: { ...scope(q), id: x.id }, update: { $set: { stock: Number(x.stock) || 0 } } } })));
  } else await replaceAll(Prod, q, a);
  s.json({ ok: 1 });
}));
app.put('/api/sales', auth, wrap(async (q, s) => {   // append-only
  const co = q.u.co, a = clean(q.body, q);
  await insertOnce(Sale, a.map(x => ({ ...x, by: q.u.name, at: Date.now() })));
  s.json({ ok: 1 });
}));

const SALE_FIELDS = ['ts', 'total', 'profit', 'items', 'refs', 'refunded', 'otot', 'cust', 'pays', 'pay'];
app.patch('/api/sales/:id', auth, need('admin', 'manager'), wrap(async (q, s) => {   // change date
  const set = {};
  for (const k of SALE_FIELDS) if (q.body[k] !== undefined) set[k] = q.body[k];
  if ('ts' in set) { set.ts = Number(set.ts); if (!set.ts) fail(400, 'Bad date'); }
  if ('cust' in set) { const c = set.cust; set.cust = c ? { name: String(c.name || '').trim().slice(0, 80), phone: String(c.phone || '').trim().slice(0, 30), note: String(c.note || '').trim().slice(0, 200) } : null; }
  if ('pay' in set) set.pay = String(set.pay || '').slice(0, 30);
  if ('pays' in set) {   // payment methods and codes can be corrected, but never the amounts, and never to or from credit
    const old = await Sale.findOne({ ...scope(q), id: q.params.id }).lean();
    if (!old) fail(404, 'Receipt not found.');
    const op = old.pays || [];
    if (!Array.isArray(set.pays) || set.pays.length !== op.length || set.pays.some((p, i) => Number(p.amt) !== Number(op[i].amt) || (p.m === 'Credit') !== (op[i].m === 'Credit'))) fail(400, 'Payment amounts cannot be changed here.');
    set.pays = set.pays.map(p => ({ m: String(p.m).slice(0, 30), amt: Number(p.amt), ref: String(p.ref || '').slice(0, 60) }));
  }
  if (!Object.keys(set).length) fail(400, 'Nothing to update');
  await Sale.updateOne({ ...scope(q), id: q.params.id }, { $set: set }); s.json({ ok: 1 });
}));
app.delete('/api/sales/:id', auth, need('admin', 'manager'), wrap(async (q, s) => {   // delete receipt
  const gone = await Sale.findOne({ ...scope(q), id: q.params.id }).lean();
  if (gone) await trashPut(q, Sale, [gone]);
  await Sale.deleteOne({ ...scope(q), id: q.params.id }); s.json({ ok: 1 });
}));
app.get('/api/trash', auth, need('admin', 'manager'), wrap(async (q, s) => s.json({ items: await Trash.find(scope(q)).sort({ at: -1 }).limit(300).select('-_id -doc -expireAt').lean() })));
app.post('/api/trash/:id/restore', auth, need('admin', 'manager'), wrap(async (q, s) => {
  const co = q.u.co, t = await Trash.findOne({ ...scope(q), id: q.params.id }).lean();
  if (!t) fail(404, 'Not found. It may have been emptied.');
  const Mo = { product: Prod, cat: Cat, expense: Expense, receipt: Sale }[t.kind], d = { ...t.doc, co };
  if (!Mo) fail(400, 'Unknown item');
  if (await Mo.findOne({ co, id: d.id }).select('id').lean()) fail(409, 'This item already exists again.');
  let note = '';
  if (t.kind === 'product') {
    if (!(await Cat.findOne({ co, id: d.cat }).select('id').lean())) {
      const tc = await Trash.findOne({ co, kind: 'cat', 'doc.id': d.cat }).lean();
      if (tc) { await insertOnce(Cat, [{ ...tc.doc, co }]); await Trash.deleteOne({ co, id: tc.id }); note = 'Its category was restored too.'; }
      else { const nc = { id: 'rc' + uid(), co, br: d.br, name: 'Restored items', hue: 40 }; await insertOnce(Cat, [nc]); d.cat = nc.id; note = 'Its category no longer exists, so it went into "Restored items".'; }
    }
    if (d.code && await Prod.findOne({ co, br: d.br, code: d.code }).select('id').lean()) { d.code = ''; note += (note ? ' ' : '') + 'Its barcode was cleared because another product uses it.'; }
  }
  await insertOnce(Mo, [d]); await Trash.deleteOne({ co, id: t.id });
  s.json({ ok: 1, kind: t.kind, doc: d, note });
}));
app.delete('/api/trash/:id', auth, need('admin'), wrap(async (q, s) => { await Trash.deleteOne({ co: q.u.co, id: q.params.id }); s.json({ ok: 1 }); }));
app.post('/api/trash/empty', auth, need('admin'), wrap(async (q, s) => { const r = await Trash.deleteMany({ co: q.u.co }); s.json({ ok: 1, n: r.deletedCount || 0 }); }));
// ---------- product photos (a small thumbnail for lists, a bigger picture on tap; kept apart from the product so the product list stays light) ----------
const imgOk = (x, max) => typeof x === 'string' && x.length <= max && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(x);
app.get('/api/photos', auth, wrap(async (q, s) => {   // thumbnails changed since a time (a removed photo comes back with an empty thumbnail)
  const now = Date.now();
  s.json({ items: await Photo.find({ co: q.u.co, at: { $gt: Number(q.query.since) || 0 } }).select('id th at -_id').limit(3000).lean(), now });
}));
app.get('/api/photo/:pid', auth, wrap(async (q, s) => { const p = await Photo.findOne({ co: q.u.co, id: q.params.pid }).select('big th -_id').lean(); s.json({ big: p && (p.big || p.th) || '' }); }));
app.put('/api/photo/:pid', auth, need('admin', 'manager'), wrap(async (q, s) => {
  const { th, big } = q.body || {};
  if (!imgOk(th, 40000) || !imgOk(big, 300000)) fail(400, 'That picture is too big or not a photo.');
  if (!(await Prod.findOne({ ...scope(q), id: q.params.pid }).select('id').lean())) fail(404, 'Product not found');
  await Photo.updateOne({ co: q.u.co, id: q.params.pid }, { $set: { th, big, at: Date.now() } }, { upsert: true }); s.json({ ok: 1 });
}));
app.delete('/api/photo/:pid', auth, need('admin', 'manager'), wrap(async (q, s) => { await Photo.updateOne({ co: q.u.co, id: q.params.pid }, { $set: { th: '', big: '', at: Date.now() } }); s.json({ ok: 1 }); }));
// ---------- sales speed per product for the restock list ----------
app.get('/api/velocity', auth, need('admin', 'manager'), wrap(async (q, s) => {
  const now = Date.now(), D = 864e5, f = { ...scope(q) };
  if (q.query.br && q.query.br !== 'all') { if (!okBr(q, q.query.br)) fail(403, 'Not allowed'); f.br = q.query.br; }
  const u = d => ({ $sum: { $cond: [{ $gte: ['$ts', now - d * D] }, '$items.qty', 0] } });
  const rows = await Sale.aggregate([{ $match: { ...f, ts: { $gte: now - 90 * D } } }, { $group: { _id: '$id', ts: { $first: '$ts' }, items: { $first: '$items' } } }, { $unwind: '$items' },
    { $group: { _id: '$items.id', u14: u(14), u30: u(30), u60: u(60), u90: { $sum: '$items.qty' }, last: { $max: '$ts' } } }]);
  s.json({ rows: rows.map(x => ({ pid: x._id, u14: x.u14, u30: x.u30, u60: x.u60, u90: x.u90, last: x.last })), now });
}));
app.put('/api/expenses', auth, need('admin', 'manager'), wrap(async (q, s) => {
  await replaceAll(Expense, q, clean(q.body, q)); s.json({ ok: 1 });
}));
const append = (path, Mo, roles) => app.put(path, auth, need(...roles), wrap(async (q, s) => {   // append-only records
  const co = q.u.co, a = clean(q.body, q);
  await insertOnce(Mo, a.map(x => ({ ...x, by: q.u.name, at: Date.now() })));
  s.json({ ok: 1 });
}));
append('/api/moves', Move, ['admin', 'manager', 'cashier']);
append('/api/logs', Log, ['admin', 'manager', 'cashier']);
append('/api/rets', Refund, ['admin', 'manager']);
append('/api/ledger', Ledger, ['admin', 'manager', 'cashier']);
app.post('/api/restore', auth, need('admin'), wrap(async (q, s) => {   // replace this company's data with a backup
  const co = q.u.co, d = q.body || {};
  const fix = a => Array.isArray(a) ? a.map(x => ({ br: 'main', ...x })) : a;   // older backups have no branches
  if (Array.isArray(d.branches) && d.branches.length) {
    await Branch.deleteMany({ co }); await Branch.insertMany(d.branches.filter(x => x && x.id).map(x => ({ ...x, co })));
  } else { await Branch.deleteMany({ co }); await newBranch(co, 'Main', '', 'main'); }
  const put = async (Mo, a) => { await Mo.deleteMany({ co }); a = fix(a); if (Array.isArray(a) && a.length) await Mo.insertMany(clean(a, q)); };
  if (d.rcpt && typeof d.rcpt === 'object') await Company.updateOne({ code: co }, { $set: { rcpt: d.rcpt } });
  if (Array.isArray(d.fields)) await Company.updateOne({ code: co }, { $set: { fields: d.fields.slice(0, 30) } });
  await put(Cat, d.cats); await put(Prod, d.prods); await put(Sale, d.sales); await put(Expense, d.expenses);
  await put(Move, d.moves); await put(Log, d.logs); await put(Refund, d.rets); await put(Lay, d.lays); await put(Ledger, d.ledger);
  await Cust.deleteMany({ co }); if (Array.isArray(d.custs) && d.custs.length) await Cust.insertMany(d.custs.filter(x => x && x.id).map(x => ({ ...x, co })));
  s.json({ ok: 1 });
}));

app.patch('/api/company', auth, need('admin'), wrap(async (q, s) => {   // currency symbol
  const cur = String(q.body.cur || '').trim().slice(0, 6);
  if (!cur) fail(400, 'Enter a currency symbol.');
  await Company.updateOne({ code: q.u.co }, { $set: { cur } }); s.json({ ok: 1, cur });
}));

app.patch('/api/company/receipt', auth, need('admin'), wrap(async (q, s) => {   // receipt design
  const d = q.body.rcpt || {}, B = x => !!x;
  const rc = { logo: d.logo === 'builtin' ? 'builtin' : typeof d.logo === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(d.logo) && d.logo.length <= 160000 ? d.logo : '', bw: B(d.bw),
    head: String(d.head || '').slice(0, 300), foot: String(d.foot || '').slice(0, 200), paper: ['58', '80', 'a4'].includes(d.paper) ? d.paper : '80',
    font: d.font === 'sans' ? 'sans' : 'mono', size: ['s', 'm', 'l'].includes(d.size) ? d.size : 'm',
    motto: B(d.motto), cashier: B(d.cashier), customer: B(d.customer), pay: B(d.pay), branch: B(d.branch) };
  await Company.updateOne({ code: q.u.co }, { $set: { rcpt: rc } }); s.json({ ok: 1, rcpt: rc });
}));
app.patch('/api/company/fields', auth, need('admin', 'manager'), wrap(async (q, s) => {   // custom columns for categories / products
  const a = Array.isArray(q.body.fields) ? q.body.fields : [];
  const fields = a.slice(0, 30).filter(x => x && x.id && String(x.name || '').trim() && ['prod', 'cat'].includes(x.t) && ['text', 'number', 'date'].includes(x.type))
    .map(x => ({ id: String(x.id).slice(0, 24), t: x.t, name: String(x.name).trim().slice(0, 40), type: x.type }));
  await Company.updateOne({ code: q.u.co }, { $set: { fields } }); s.json({ ok: 1, fields });
}));

// ---------- customers, credit ledger, layaways ----------
app.put('/api/custs', auth, wrap(async (q, s) => {   // add or change customer accounts (never deleted, only archived)
  if (!Array.isArray(q.body)) fail(400, 'Bad data');
  for (const x of q.body.slice(0, 500)) {
    if (!x || !x.id || !String(x.name || '').trim()) continue;
    const old = await Cust.findOne({ co: q.u.co, id: String(x.id) }).lean();
    const limit = q.u.role === 'cashier' ? (old ? old.limit || 0 : 0) : Math.max(0, Number(x.limit) || 0);   // only managers set credit limits
    const doc = { id: String(x.id), co: q.u.co, name: String(x.name).trim().slice(0, 80), phone: String(x.phone || '').trim().slice(0, 30), note: String(x.note || '').slice(0, 200), limit, archived: !!x.archived, at: Date.now() };
    await Cust.replaceOne({ co: q.u.co, id: doc.id }, doc, { upsert: true });
  }
  s.json({ ok: 1 });
}));
app.put('/api/lays', auth, wrap(async (q, s) => {   // layaways change over time (payments, completion), so they are saved in place
  for (const x of clean(q.body, q).slice(0, 200)) await Lay.replaceOne({ co: q.u.co, id: x.id }, { ...x, at: Date.now() }, { upsert: true });
  s.json({ ok: 1 });
}));
app.get('/api/bals', auth, wrap(async (q, s) => {
  const bl = await Ledger.aggregate([{ $match: { co: q.u.co } }, { $group: { _id: '$id', cid: { $first: '$cid' }, amt: { $first: '$amt' } } }, { $group: { _id: '$cid', bal: { $sum: '$amt' } } }]);
  s.json({ bals: Object.fromEntries(bl.map(x => [x._id, Math.round(x.bal * 100) / 100])) });
}));
app.get('/api/ledger', auth, wrap(async (q, s) => {   // one customer's statement
  const f = { co: q.u.co };
  if (q.query.cid) f.cid = String(q.query.cid); else if (q.query.from) f.ts = { $gte: Number(q.query.from), $lt: Number(q.query.to) || Date.now() }; else return s.json({ docs: [] });
  s.json({ docs: await Ledger.find(f).select('-_id').sort({ ts: 1 }).limit(2000).lean() });
}));
app.get('/api/ledgerall', auth, need('admin'), wrap(async (q, s) => {   // for the full backup
  s.json({ docs: await Ledger.find({ co: q.u.co }).select('-_id').sort({ ts: 1 }).limit(100000).lean() });
}));
app.get('/api/serial', auth, wrap(async (q, s) => {   // which receipt did this serial number / IMEI go out on?
  const sn = String(q.query.sn || '').trim();
  if (sn.length < 4) return s.json({ docs: [] });
  const rx = sn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  s.json({ docs: await Sale.find({ ...scope(q), 'items.sn': { $regex: rx, $options: 'i' } }).select('-_id').sort({ ts: -1 }).limit(30).lean() });
}));
app.get('/api/findsales', auth, wrap(async (q, s) => {   // global search: older receipts by number, customer, item or serial
  const x = String(q.query.q || '').trim();
  if (x.length < 2) return s.json({ docs: [] });
  const rx = x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), or = [{ 'cust.name': { $regex: rx, $options: 'i' } }, { 'cust.phone': { $regex: rx } }, { 'items.name': { $regex: rx, $options: 'i' } }, { 'items.sn': { $regex: rx, $options: 'i' } }];
  if (/^#?\d+$/.test(x)) or.push({ no: Number(x.replace('#', '')) });
  s.json({ docs: await Sale.find({ ...scope(q), $or: or }).select('-_id').sort({ ts: -1 }).limit(30).lean() });
}));
app.get('/api/lastsold', auth, need('admin', 'manager'), wrap(async (q, s) => {   // when did each product last sell (for the aged stock report)
  const rows = await Sale.aggregate([{ $match: scope(q) }, { $unwind: '$items' }, { $group: { _id: '$items.id', last: { $max: '$ts' } } }]);
  s.json({ last: Object.fromEntries(rows.map(r => [r._id, r.last])) });
}));

// ---------- subscription status (works even when blocked, so the app can explain why) ----------
app.get('/api/sub', authNoSub, wrap(async (q, s) => { delete subCache[q.u.co]; s.json({ sub: await subOf(q.u.co) }); }));

// ---------- owner console (needs OWNER_KEY): manage which companies have an active subscription ----------
const ownerTries = {};
function ownerAuth(q, s, n) {
  const key = process.env.OWNER_KEY;
  if (!key) return s.status(404).json({ error: 'The owner console is not enabled. Set OWNER_KEY on the server.' });
  const t = ownerTries[q.ip] = (ownerTries[q.ip] || []).filter(x => Date.now() - x < 900000);
  if (t.length >= 10) return s.status(429).json({ error: 'Too many attempts. Try again later.' });
  const a = Buffer.from(String(q.headers['x-owner-key'] || '')), b = Buffer.from(key);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) { t.push(Date.now()); return s.status(401).json({ error: 'Wrong owner key.' }); }
  n();
}
app.get('/api/owner/companies', ownerAuth, wrap(async (q, s) => {
  const cs = await Company.find({}).select('-_id code name phone created sub').lean();
  const uc = await User.aggregate([{ $group: { _id: '$co', n: { $sum: 1 } } }]), m = Object.fromEntries(uc.map(x => [x._id, x.n]));
  s.json({ trial: SUBCFG().trial, grace: SUBCFG().grace, companies: cs.map(c => ({ code: c.code, name: c.name, phone: c.phone, created: c.created || null, users: m[c.code] || 0, info: subInfo(c) })) });
}));
app.post('/api/owner/subscription', ownerAuth, wrap(async (q, s) => {
  const d = q.body, c = await Company.findOne({ code: String(d.code || '').toUpperCase() }).lean();
  if (!c) fail(404, 'Company not found.');
  const cur = c.sub || {}, sub = { ...cur, updated: Date.now() };
  if (d.until) { const u = Date.parse(String(d.until) + 'T23:59:59Z'); if (!u) fail(400, 'Bad date.'); sub.until = u; }
  else if (d.addDays) sub.until = Math.max(Date.now(), cur.until || 0) + Math.min(Number(d.addDays) || 0, 3650) * 864e5;
  if (d.plan) sub.plan = String(d.plan).slice(0, 30);
  if (d.status) sub.status = d.status === 'suspended' ? 'suspended' : 'active';
  if (d.note !== undefined) sub.note = String(d.note).slice(0, 200);
  await Company.updateOne({ code: c.code }, { $set: { sub } }); delete subCache[c.code];
  s.json({ ok: 1, info: subInfo({ sub }) });
}));
app.post('/api/owner/recovery', ownerAuth, wrap(async (q, s) => {   // only the owner can make a new recovery code (for example if JWT_SECRET was changed)
  const code = rcode(), co = String(q.body.code || '').toUpperCase();
  if (!(await Company.findOne({ code: co }).lean())) fail(404, 'Company not found.');
  await Company.updateOne({ code: co }, { rh: await bcrypt.hash(code, 10), renc: encCode(code) }); s.json({ code });
}));

// ---------- receipt numbers: the server hands out the next number so two devices never use the same one ----------
async function nextSeq(co, br, k) {
  const f = { co, br, k };
  if (!(await Counter.findOne(f).lean())) {   // first use: carry on from the highest number already used in this branch
    const m = k === 'lay' ? await Lay.find({ co, br, no: { $lt: 100000 } }).sort({ no: -1 }).limit(1).lean() : await Sale.find({ co, br, no: { $lt: 100000 } }).sort({ no: -1 }).limit(1).lean();
    await Counter.updateOne(f, { $setOnInsert: { seq: m.length ? m[0].no || 0 : 0 } }, { upsert: true });
  }
  return (await Counter.findOneAndUpdate(f, { $inc: { seq: 1 } }, { new: true }).lean()).seq;
}
app.post('/api/seq', auth, wrap(async (q, s) => {
  const br = String(q.body.br || ''), k = q.body.k === 'lay' ? 'lay' : 'rcpt';
  if (!okBr(q, br)) fail(403, 'Not allowed for that branch.');
  s.json({ no: await nextSeq(q.u.co, br, k) });
}));
app.post('/api/device', auth, wrap(async (q, s) => {   // each device gets a small number, used to number receipts made while offline (for example 2 -> D2-0001)
  const f = { co: q.u.co, br: '_', k: 'dev' };
  await Counter.updateOne(f, { $setOnInsert: { seq: 0 } }, { upsert: true });
  s.json({ dev: ((await Counter.findOneAndUpdate(f, { $inc: { seq: 1 } }, { new: true }).lean()).seq - 1) % 900 + 1 });
}));
const COPY_MODELS = [Sale, Move, Log, Refund, Ledger, Lay];
const copyGroups = (Mo, co) => Mo.aggregate([{ $match: { co } }, { $group: { _id: '$id', n: { $sum: 1 }, keep: { $first: '$_id' }, all: { $push: '$_id' } } }, { $match: { n: { $gt: 1 } } }, { $limit: 5000 }]);
async function removeCopies(co, dry) {   // the same record saved more than once: keep one, delete the rest
  let n = 0;
  for (const Mo of COPY_MODELS) for (const g of await copyGroups(Mo, co)) { const extra = g.all.filter(x => String(x) !== String(g.keep)); n += extra.length; if (!dry) await Mo.deleteMany({ _id: { $in: extra } }); }
  return n;
}
const dupeGroups = co => Sale.aggregate([{ $match: { co, no: { $ne: null } } }, { $group: { _id: { br: '$br', no: '$no' }, ids: { $addToSet: '$id' } } }, { $match: { 'ids.1': { $exists: true } } }, { $limit: 500 }]);
app.get('/api/dupes', auth, need('admin'), wrap(async (q, s) => {
  const g = await dupeGroups(q.u.co); s.json({ copies: await removeCopies(q.u.co, true), groups: g.length, extra: g.reduce((a, x) => a + x.ids.length - 1, 0) });
}));
app.post('/api/dupes/fix', auth, need('admin'), wrap(async (q, s) => {   // remove repeated copies, then give clashing receipt numbers to the later receipts (the oldest keeps its number)
  const co = q.u.co, removed = await removeCopies(co); let fixed = 0;
  for (const x of await dupeGroups(co)) {
    const docs = await Sale.find({ co, br: x._id.br, no: x._id.no }).sort({ ts: 1 }).select('id').lean();
    for (const d of docs) if (d.id !== docs[0].id) { await Sale.updateOne({ co, id: d.id }, { $set: { no: await nextSeq(co, x._id.br, 'rcpt'), oldNo: x._id.no } }); fixed++; }
  }
  await ensureIndexes(); s.json({ fixed, removed });
}));

// ---------- stock transfers between branches (the receiving branch accepts or declines) ----------
const rxe = T.rxEsc, nameRx = n => ({ $regex: '^' + rxe(n) + '$', $options: 'i' });
const store = {
  prod: (co, br, id) => Prod.findOne({ co, br, id }).lean(),
  catById: (co, id) => Cat.findOne({ co, id }).lean(),
  catByName: (co, br, name) => Cat.findOne({ co, br, name: nameRx(name) }).lean(),
  findProd: async (co, br, { code, cat, name }) => (code && await Prod.findOne({ co, br, code }).lean()) || Prod.findOne({ co, br, cat, name: nameRx(name) }).lean(),
  addCat: d => Cat.create(d), addProd: d => Prod.create(d),
  takeQty: async (co, id, qty) => !!(await Prod.updateOne({ co, id, stock: { $gte: qty } }, { $inc: { stock: -qty } })).modifiedCount,
  takeSns: async (co, id, sns) => !!(await Prod.updateOne({ co, id, sns: { $all: sns } }, { $pull: { sns: { $in: sns } }, $inc: { stock: -sns.length } })).modifiedCount,
  giveQty: (co, id, qty) => Prod.updateOne({ co, id }, { $inc: { stock: qty } }),
  giveSns: async (co, id, sns) => { await Prod.updateOne({ co, id }, { $addToSet: { sns: { $each: sns } } }); const p = await Prod.findOne({ co, id }).lean(); await Prod.updateOne({ co, id }, { $set: { stock: (p.sns || []).length } }); },
  claim: (co, id, from, to, extra) => Trf.findOneAndUpdate({ co, id, status: from }, { $set: { status: to, ...extra, at: Date.now() } }).lean(),   // returns the document as it was before
  addTrf: d => Trf.create(d), addMoves: a => a.length ? Move.insertMany(a) : null,
  stockOf: async (co, id) => { const p = await Prod.findOne({ co, id }).lean(); return p ? p.stock : 0; },
  nextNo: async co => { const l = await Trf.find({ co }).sort({ no: -1 }).limit(1).lean(); return l.length ? l[0].no + 1 : 1; }
};
const tctx = { uid, now: () => Date.now() };
const getTrf = async q => { const t = await Trf.findOne({ co: q.u.co, id: q.params.id }).lean(); if (!t) fail(404, 'Transfer not found.'); return t; };
app.post('/api/transfers', auth, need('admin', 'manager'), wrap(async (q, s) => {   // send products to another branch (taken from stock now, added when accepted)
  const d = q.body, co = q.u.co, from = String(d.from || ''), to = String(d.to || '');
  if (!okBr(q, from)) fail(403, 'You cannot send from that branch.');
  if (!to || to === from) fail(400, 'Choose a different branch to send to.');
  if (!(await Branch.findOne({ co, id: to }).lean())) fail(404, 'The receiving branch was not found.');
  const t = await T.createTransfer(store, tctx, { co, from, to, items: d.items, note: d.note, by: q.u.name });
  s.json({ ok: 1, id: t.id, no: t.no });
}));
app.post('/api/transfers/:id/accept', auth, wrap(async (q, s) => {
  const t = await getTrf(q); if (!okBr(q, t.to)) fail(403, 'Only people at the receiving branch can accept this transfer.');
  await T.acceptTransfer(store, tctx, { co: q.u.co, id: t.id, by: q.u.name, note: q.body.note }); s.json({ ok: 1 });
}));
app.post('/api/transfers/:id/decline', auth, wrap(async (q, s) => {
  const t = await getTrf(q); if (!okBr(q, t.to)) fail(403, 'Only people at the receiving branch can decline this transfer.');
  await T.returnTransfer(store, tctx, { co: q.u.co, id: t.id, by: q.u.name, note: q.body.note, status: 'declined' }); s.json({ ok: 1 });
}));
app.post('/api/transfers/:id/cancel', auth, need('admin', 'manager'), wrap(async (q, s) => {
  const t = await getTrf(q); if (!okBr(q, t.from)) fail(403, 'Only the sending branch can cancel this transfer.');
  await T.returnTransfer(store, tctx, { co: q.u.co, id: t.id, by: q.u.name, note: q.body.note, status: 'cancelled' }); s.json({ ok: 1 });
}));

// ---------- branches (admin only) ----------
app.post('/api/branches', auth, need('admin'), wrap(async (q, s) => {
  const name = String(q.body.name || '').trim();
  if (!name) fail(400, 'Enter a branch name.');
  if (await Branch.findOne({ co: q.u.co, name })) fail(409, 'A branch with that name already exists.');
  s.json(await newBranch(q.u.co, name, String(q.body.loc || '').trim()));
}));
app.patch('/api/branches/:id', auth, need('admin'), wrap(async (q, s) => {
  const name = String(q.body.name || '').trim();
  if (!name) fail(400, 'Enter a branch name.');
  await Branch.updateOne({ co: q.u.co, id: q.params.id }, { $set: { name, loc: String(q.body.loc || '').trim() } }); s.json({ ok: 1 });
}));
app.delete('/api/branches/:id', auth, need('admin'), wrap(async (q, s) => {
  const co = q.u.co, id = q.params.id;
  if ((await Branch.countDocuments({ co })) < 2) fail(400, 'You need at least one branch.');
  if ((await Prod.countDocuments({ co, br: id })) || (await Sale.countDocuments({ co, br: id }))) fail(400, 'This branch still has products or sales. Move them first.');
  await Branch.deleteOne({ co, id });
  for (const Mo of [Cat, Expense, Move, Log, Refund]) await Mo.deleteMany({ co, br: id });
  await User.updateMany({ co }, { $pull: { br: id } });
  s.json({ ok: 1 });
}));

// ---------- passwords ----------
const tries = {};
app.post('/api/reset', wrap(async (q, s) => {   // forgot password: company code + recovery code
  const d = q.body, code = String(d.code || '').trim().toUpperCase(), user = String(d.user || '').trim().toLowerCase();
  const key = q.ip + code, t = tries[key] = (tries[key] || []).filter(x => Date.now() - x < 900000);
  if (t.length >= 5) fail(429, 'Too many attempts. Try again in 15 minutes.');
  t.push(Date.now());
  const c = await Company.findOne({ code }), u = await User.findOne({ co: code, user });
  if (!c || !c.rh || !u || !(await bcrypt.compare(String(d.recovery || '').trim().toUpperCase(), c.rh))) fail(401, 'Company code, username or recovery code is wrong.');
  if (String(d.pass || '').length < 4) fail(400, 'Password must be at least 4 characters.');
  await User.updateOne({ co: code, id: u.id }, { h: await bcrypt.hash(String(d.pass), 10) }); s.json({ ok: 1 });
}));
app.post('/api/recovery/show', auth, need('admin'), wrap(async (q, s) => {   // admin looks at the recovery code again (password required)
  const key = 'rcv' + q.u.id, t = tries[key] = (tries[key] || []).filter(x => Date.now() - x < 900000);
  if (t.length >= 5) fail(429, 'Too many attempts. Try again in 15 minutes.');
  t.push(Date.now());
  const u = await User.findOne({ co: q.u.co, id: q.u.id });
  if (!(await bcrypt.compare(String(q.body.pass || ''), u.h))) fail(401, 'That password is wrong.');
  const c = await Company.findOne({ code: q.u.co }).select('renc').lean();
  let code = c && c.renc ? decCode(c.renc) : null, created = false;
  if (!code) { code = rcode(); created = true; await Company.updateOne({ code: q.u.co }, { rh: await bcrypt.hash(code, 10), renc: encCode(code) }); }   // older companies get their first viewable code here
  s.json({ code, created });
}));
app.post('/api/password', auth, wrap(async (q, s) => {   // change my own password
  const d = q.body, u = await User.findOne({ co: q.u.co, id: q.u.id });
  if (!(await bcrypt.compare(String(d.cur || ''), u.h))) fail(401, 'Current password is wrong.');
  if (String(d.pass || '').length < 4) fail(400, 'Password must be at least 4 characters.');
  await User.updateOne({ co: q.u.co, id: q.u.id }, { h: await bcrypt.hash(String(d.pass), 10) }); s.json({ ok: 1 });
}));
app.patch('/api/users/:id/password', auth, need('admin'), wrap(async (q, s) => {   // admin resets a user's password
  if (String(q.body.pass || '').length < 4) fail(400, 'Password must be at least 4 characters.');
  await User.updateOne({ co: q.u.co, id: q.params.id }, { h: await bcrypt.hash(String(q.body.pass), 10) }); s.json({ ok: 1 });
}));

// ---------- users (admin only) ----------
const goodBr = async (co, a) => { const ids = (await Branch.find({ co }).select('id').lean()).map(x => x.id); return (Array.isArray(a) ? a : []).filter(x => ids.includes(x)); };
app.post('/api/users', auth, need('admin'), wrap(async (q, s) => {
  const d = q.body, user = String(d.user || '').trim().toLowerCase();
  if (!user || !d.name || !d.pass || String(d.pass).length < 4 || !ROLES.includes(d.role)) fail(400, 'Invalid user details.');
  if (await User.findOne({ co: q.u.co, user })) fail(409, 'Username already exists.');
  const br = d.role === 'admin' ? [] : await goodBr(q.u.co, d.br);
  if (d.role !== 'admin' && !br.length) fail(400, 'Choose at least one branch for this user.');
  s.json(pub(await User.create({ id: uid(), co: q.u.co, user, name: String(d.name).trim(), role: d.role, br, h: await bcrypt.hash(String(d.pass), 10) })));
}));
app.patch('/api/users/:id', auth, need('admin'), wrap(async (q, s) => {   // change role, branches and/or password
  const set = {}, u = await User.findOne({ co: q.u.co, id: q.params.id }).lean();
  if (!u) fail(404, 'User not found.');
  if (q.body.role !== undefined) { if (!ROLES.includes(q.body.role)) fail(400, 'Bad role'); set.role = q.body.role; }
  if (q.body.br !== undefined) set.br = await goodBr(q.u.co, q.body.br);
  if ((set.role || u.role) !== 'admin' && !(set.br || u.br || []).length) set.br = [(await Branch.findOne({ co: q.u.co }).lean() || {}).id].filter(Boolean);
  if (q.body.pass !== undefined) { if (String(q.body.pass).length < 4) fail(400, 'Password must be at least 4 characters.'); set.h = await bcrypt.hash(String(q.body.pass), 10); }
  if (!Object.keys(set).length) fail(400, 'Nothing to update');
  await User.updateOne({ co: q.u.co, id: q.params.id }, { $set: set }); s.json({ ok: 1, br: set.br });
}));
app.delete('/api/users/:id', auth, need('admin'), wrap(async (q, s) => {
  if (q.params.id === q.u.id) fail(400, 'You cannot delete yourself.');
  await User.deleteOne({ co: q.u.co, id: q.params.id }); s.json({ ok: 1 });
}));

const ensureIndexes = () => Promise.all([Trash.collection.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 }).catch(() => {}), Trash.collection.createIndex({ co: 1, at: -1 }).catch(() => {}), Photo.collection.createIndex({ co: 1, id: 1 }, { unique: true }).catch(() => {}), Sale, Move, Log, Refund, Ledger, Lay, Cust, Trf].map(Mo => Mo.collection.createIndex({ co: 1, id: 1 }, { unique: true }).catch(e => console.log('Index note (' + Mo.modelName + '): ' + e.message))));
app.ensureIndexes = ensureIndexes;   // also used by the Netlify function
module.exports = app;   // used by the Netlify function

if (require.main === module) {   // normal `npm start` (Render, Railway, local)
  if (!SECRET || !process.env.MONGODB_URI) { console.error('Set MONGODB_URI and JWT_SECRET in .env'); process.exit(1); }
  mongoose.connect(process.env.MONGODB_URI)
    .then(() => { ensureIndexes(); return app.listen(process.env.PORT || 3000, () => console.log('POS running on port ' + (process.env.PORT || 3000))); })
    .catch(e => { console.error(e.message); process.exit(1); });
}
