require('dotenv').config();
// Only needed on devices whose DNS can't look up Atlas (querySrv EBADRESP, e.g. Termux): set DNS_SERVERS=8.8.8.8,1.1.1.1 in .env
if (process.env.DNS_SERVERS) require('dns').setServers(process.env.DNS_SERVERS.split(',').map(x => x.trim()));
const express = require('express'), mongoose = require('mongoose'), bcrypt = require('bcryptjs'),
      jwt = require('jsonwebtoken'), path = require('path'), crypto = require('crypto');
const SECRET = process.env.JWT_SECRET;

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- models ----------
const M = (n, f = {}) => mongoose.model(n, new mongoose.Schema(
  { co: { type: String, index: true }, id: String, ...f }, { strict: false, versionKey: false, id: false }));
const Company = mongoose.model('Company', new mongoose.Schema(
  { code: { type: String, unique: true }, name: String, loc: String, motto: String, phone: String, cur: String, fields: { type: Array, default: [] }, v: { type: Object, default: {} }, rcpt: { type: Object, default: {} }, rh: String }, { versionKey: false }));
const User = M('User', { user: String, name: String, role: String, h: String });
const Branch = M('Branch', { name: String, loc: String });
const Cat = M('Cat'), Prod = M('Prod'), Sale = M('Sale'), Expense = M('Expense'), Move = M('Move'), Log = M('Log'), Refund = M('Refund'), Lay = M('Lay'), Ledger = M('Ledger'), Cust = M('Cust');
const DATA = [Cat, Prod, Sale, Expense, Move, Log, Refund, Lay, Ledger];   // everything that belongs to one branch (has a `br` field)

// ---------- helpers ----------
const ROLES = ['admin', 'manager', 'cashier'];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const fail = (c, m) => { const e = new Error(m); e.status = c; throw e; };
const wrap = f => (q, s) => f(q, s).catch(e => s.status(e.status || 500).json({ error: e.message || 'Server error' }));
const rcode = () => [...crypto.randomBytes(12)].map(b => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('').replace(/(.{4})(?=.)/g, '$1-');
const tok = u => jwt.sign({ uid: u.id }, SECRET, { expiresIn: '7d' });
const pub = u => ({ id: u.id, co: u.co, user: u.user, name: u.name, role: u.role, br: u.br || [] });
// Branch access: admins see every branch; managers and cashiers only the branches assigned to them.
const scope = q => q.u.role === 'admin' ? { co: q.u.co } : { co: q.u.co, br: { $in: q.u.br || [] } };
const okBr = (q, b) => !!b && (q.u.role === 'admin' || (q.u.br || []).includes(b));
const clean = (a, q) => { if (!Array.isArray(a) || a.length > 20000) fail(400, 'Bad data'); return a.filter(x => x && x.id && okBr(q, x.br)).map(x => ({ ...x, co: q.u.co })); };
const newBranch = async (co, name, loc = '', id = uid()) => { await Branch.updateOne({ co, id }, { $setOnInsert: { co, id, name, loc } }, { upsert: true }); return { id, co, name, loc }; };
async function ensureBranch(co) {   // companies created before branches existed get one branch ("Main") that owns all their data
  if (await Branch.countDocuments({ co })) return;
  await newBranch(co, 'Main', '', 'main');
  for (const Mo of DATA) await Mo.updateMany({ co, br: { $exists: false } }, { $set: { br: 'main' } });
  await User.updateMany({ co, role: { $ne: 'admin' }, br: { $exists: false } }, { $set: { br: ['main'] } });
}
async function auth(q, s, n) {
  try {
    const p = jwt.verify((q.headers.authorization || '').slice(7), SECRET);
    const u = await User.findOne({ id: p.uid }).lean();   // role and branches are read fresh on every request
    if (!u) throw 0;
    q.u = u; n();
  } catch (e) { s.status(401).json({ error: 'Please log in again' }); }
}
const need = (...r) => (q, s, n) => r.includes(q.u.role) ? n() : s.status(403).json({ error: 'Not allowed for your role' });
const replaceAll = (Mo, q, a) => Mo.bulkWrite([
  { deleteMany: { filter: { ...scope(q), id: { $nin: a.map(x => x.id) } } } },
  ...a.map(x => ({ replaceOne: { filter: { co: q.u.co, id: x.id }, replacement: x, upsert: true } }))]);

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
      else if (p === '/api/restore') ks = ['org', 'salesx', 'prods', 'cats', 'expenses', 'moves', 'logs', 'rets', 'custs', 'lays', 'ledger'];
      else if (/^\/api\/(users|branches|company|password|recovery)/.test(p)) ks = ['org'];
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
  const d = q.body, code = String(d.code || '').trim().toUpperCase(), user = String(d.user || '').trim().toLowerCase();
  if (!code || !user || !d.name || !d.pass || String(d.pass).length < 4) fail(400, 'Fill in all fields (password min 4 characters).');
  if (await Company.findOne({ code })) fail(409, 'That company code is already in use.');
  const recovery = rcode();
  await Company.create({ code, name: String(d.name).trim(), loc: d.loc, motto: d.motto, phone: d.phone, rh: await bcrypt.hash(recovery, 10) });
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
  const [company, users, branches, cats, prods, sales, expenses, rets, moves, logs, custs, lays, bl] = await Promise.all([
    Company.findOne({ code: q.u.co }).select('-_id -rh').lean(), User.find({ co: q.u.co }).select('-_id -h').lean(),
    Branch.find(adm ? { co: q.u.co } : { co: q.u.co, id: { $in: q.u.br || [] } }).select('-_id').lean(),
    L(Cat), L(Prod), L(Sale, { ts: { $gte: cut } }, 5000, { ts: -1 }),
    mgr ? L(Expense, { ts: { $gte: cut } }) : [], mgr ? L(Refund, { ts: { $gte: cut } }) : [],
    mgr ? L(Move, {}, 500, { ts: -1 }) : [], adm ? L(Log, {}, 500, { ts: -1 }) : [],
    Cust.find({ co: q.u.co }).select('-_id').lean(), L(Lay, { $or: [{ status: 'open' }, { ts: { $gte: cut } }] }), Ledger.aggregate([{ $match: { co: q.u.co } }, { $group: { _id: '$cid', bal: { $sum: '$amt' } } }])]);
  const bals = Object.fromEntries(bl.map(x => [x._id, Math.round(x.bal * 100) / 100]));
  const win = sales.length >= 5000 ? Math.min(...sales.map(x => x.ts)) : cut;
  s.json({ company, users, branches, cats, prods, sales, expenses, rets, moves, logs, custs, lays, bals, me: q.u.id, v: (company && company.v) || {}, now, win });
}));
app.get('/api/ver', auth, wrap(async (q, s) => {   // tiny: lets a device check whether anything changed
  const c = await Company.findOne({ code: q.u.co }).select('v -_id').lean(); s.json({ v: (c && c.v) || {} });
}));
app.get('/api/range', auth, wrap(async (q, s) => {   // older sales, refunds and expenses on request
  const f = { ...scope(q), ts: { $gte: Number(q.query.from) || 0, $lt: Number(q.query.to) || Date.now() } }, mgr = q.u.role !== 'cashier';
  const [sales, rets, expenses] = await Promise.all([Sale.find(f).select('-_id').sort({ ts: -1 }).limit(20000).lean(), mgr ? Refund.find(f).select('-_id').lean() : [], mgr ? Expense.find(f).select('-_id').lean() : []]);
  s.json({ sales, rets, expenses, truncated: sales.length >= 20000 });
}));
const DELTA = { lays: [Lay, 'c'], custs: [Cust, 'c'], sales: [Sale, 'c'], moves: [Move, 'm'], logs: [Log, 'a'], rets: [Refund, 'm'] };
app.get('/api/delta/:c', auth, wrap(async (q, s) => {   // only records added since the last check
  const now = Date.now(), d = DELTA[q.params.c], r = q.u.role;
  if (!d) fail(404, 'Unknown collection');
  if ((d[1] === 'm' && r === 'cashier') || (d[1] === 'a' && r !== 'admin')) return s.json({ docs: [], now });
  const docs = await d[0].find({ ...(q.params.c === 'custs' ? { co: q.u.co } : scope(q)), at: { $gt: Number(q.query.after) || 0 } }).select('-_id').sort({ at: 1 }).limit(3000).lean();
  s.json({ docs, now, more: docs.length >= 3000, last: docs.length ? docs[docs.length - 1].at : 0 });
}));
const COL2 = { prods: Prod, cats: Cat, expenses: Expense };
app.get('/api/col/:c', auth, wrap(async (q, s) => {   // one whole collection (products, categories, expenses)
  const now = Date.now(), m = COL2[q.params.c];
  if (!m) fail(404, 'Unknown collection');
  if (q.params.c === 'expenses' && q.u.role === 'cashier') return s.json({ docs: [], now });
  const f = { ...scope(q) }; if (q.params.c === 'expenses') f.ts = { $gte: Number(q.query.from) || 0 };
  s.json({ docs: await m.find(f).select('-_id').lean(), now });
}));
app.get('/api/monthly', auth, need('admin', 'manager'), wrap(async (q, s) => {   // sales totals per month, worked out by the database
  const match = { ...scope(q), ts: { $gte: Number(q.query.from), $lt: Number(q.query.to) } };
  if (q.query.br && q.query.br !== 'all') { if (!okBr(q, q.query.br)) fail(403, 'Not allowed'); match.br = q.query.br; }
  let rows;
  try { rows = await Sale.aggregate([{ $match: match }, { $group: { _id: { $month: { date: { $toDate: '$ts' }, timezone: String(q.query.tz || 'UTC') } }, n: { $sum: 1 }, rev: { $sum: '$total' }, profit: { $sum: '$profit' } } }]); }
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
  const have = new Set((await Sale.find({ co, id: { $in: a.map(x => x.id) } }).select('id').lean()).map(x => x.id));
  const n = a.filter(x => !have.has(x.id)).map(x => ({ ...x, by: q.u.name, at: Date.now() }));
  if (n.length) await Sale.insertMany(n);
  s.json({ ok: 1 });
}));

const SALE_FIELDS = ['ts', 'total', 'profit', 'items', 'refs', 'refunded', 'otot'];
app.patch('/api/sales/:id', auth, need('admin', 'manager'), wrap(async (q, s) => {   // change date
  const set = {};
  for (const k of SALE_FIELDS) if (q.body[k] !== undefined) set[k] = q.body[k];
  if ('ts' in set) { set.ts = Number(set.ts); if (!set.ts) fail(400, 'Bad date'); }
  if (!Object.keys(set).length) fail(400, 'Nothing to update');
  await Sale.updateOne({ ...scope(q), id: q.params.id }, { $set: set }); s.json({ ok: 1 });
}));
app.delete('/api/sales/:id', auth, need('admin', 'manager'), wrap(async (q, s) => {   // delete receipt
  await Sale.deleteOne({ ...scope(q), id: q.params.id }); s.json({ ok: 1 });
}));
app.put('/api/expenses', auth, need('admin', 'manager'), wrap(async (q, s) => {
  await replaceAll(Expense, q, clean(q.body, q)); s.json({ ok: 1 });
}));
const append = (path, Mo, roles) => app.put(path, auth, need(...roles), wrap(async (q, s) => {   // append-only records
  const co = q.u.co, a = clean(q.body, q);
  const have = new Set((await Mo.find({ co, id: { $in: a.map(x => x.id) } }).select('id').lean()).map(x => x.id));
  const n = a.filter(x => !have.has(x.id)).map(x => ({ ...x, by: q.u.name, at: Date.now() }));
  if (n.length) await Mo.insertMany(n);
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
  const bl = await Ledger.aggregate([{ $match: { co: q.u.co } }, { $group: { _id: '$cid', bal: { $sum: '$amt' } } }]);
  s.json({ bals: Object.fromEntries(bl.map(x => [x._id, Math.round(x.bal * 100) / 100])) });
}));
app.get('/api/ledger', auth, wrap(async (q, s) => {   // one customer's statement
  s.json({ docs: await Ledger.find({ co: q.u.co, cid: String(q.query.cid || '') }).select('-_id').sort({ ts: 1 }).limit(2000).lean() });
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
app.get('/api/lastsold', auth, need('admin', 'manager'), wrap(async (q, s) => {   // when did each product last sell (for the aged stock report)
  const rows = await Sale.aggregate([{ $match: scope(q) }, { $unwind: '$items' }, { $group: { _id: '$items.id', last: { $max: '$ts' } } }]);
  s.json({ last: Object.fromEntries(rows.map(r => [r._id, r.last])) });
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
app.post('/api/recovery', auth, need('admin'), wrap(async (q, s) => {
  const code = rcode(); await Company.updateOne({ code: q.u.co }, { rh: await bcrypt.hash(code, 10) }); s.json({ code });
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

module.exports = app;   // used by the Netlify function

if (require.main === module) {   // normal `npm start` (Render, Railway, local)
  if (!SECRET || !process.env.MONGODB_URI) { console.error('Set MONGODB_URI and JWT_SECRET in .env'); process.exit(1); }
  mongoose.connect(process.env.MONGODB_URI)
    .then(() => app.listen(process.env.PORT || 3000, () => console.log('POS running on port ' + (process.env.PORT || 3000))))
    .catch(e => { console.error(e.message); process.exit(1); });
}
