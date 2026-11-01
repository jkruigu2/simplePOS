// Stock-transfer rules between branches. Written against a small "store" so the logic can be tested without a database;
// server.js supplies a MongoDB store with the same methods.
const httpErr = (status, message) => { const e = new Error(message); e.status = status; return e; };
const rxEsc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Put an item into a branch: find or create its category and product there, then add the quantity or serial numbers.
async function receive(st, ctx, co, br, it) {
  const catName = it.cat || 'Transfers';
  let c = await st.catByName(co, br, catName);
  if (!c) { c = { id: ctx.uid(), co, br, name: catName, hue: it.hue || 0 }; await st.addCat(c); }
  let p = await st.findProd(co, br, { code: it.code || '', cat: c.id, name: it.name });
  if (!p) {
    p = { id: ctx.uid(), co, br, cat: c.id, name: it.name, code: it.code || '', buy: it.buy, price: it.price, stock: 0, ext: it.ext || {}, ...(it.ser ? { ser: true, sns: [] } : {}) };
    await st.addProd(p);
  }
  if (!!p.ser !== !!it.ser) throw httpErr(409, 'Serial tracking is set differently for "' + it.name + '" in the other branch.');
  if (p.ser) await st.giveSns(co, p.id, it.sns || []); else await st.giveQty(co, p.id, it.qty);
  return p;
}

const mvDoc = (ctx, co, br, p, qty, ref, note, by, after) => ({ id: ctx.uid(), co, br, ts: ctx.now(), at: ctx.now(), pid: p.id, name: p.name, qty, type: 'transfer', ref, note: note || '', after, by });

// Take the items out of the sending branch and record a pending transfer. Anything taken is put back if any item fails.
async function createTransfer(st, ctx, { co, from, to, items, note, by }) {
  if (!Array.isArray(items) || !items.length) throw httpErr(400, 'Choose at least one item.');
  const seen = new Set(), taken = [], out = [];
  try {
    for (const it of items.slice(0, 200)) {
      const id = String(it.id);
      if (seen.has(id)) throw httpErr(400, 'The same product is listed twice.');
      seen.add(id);
      const p = await st.prod(co, from, id);
      if (!p) throw httpErr(404, 'A product was not found in the sending branch.');
      const cat = await st.catById(co, p.cat), base = { id: p.id, name: p.name, code: p.code || '', cat: cat ? cat.name : '', hue: cat ? cat.hue : 0, buy: p.buy, price: p.price, ext: p.ext || {} };
      if (p.ser) {
        const sns = [...new Set((it.sns || []).map(String))];
        if (!sns.length) throw httpErr(400, 'Choose the serial numbers to send for ' + p.name + '.');
        if (!(await st.takeSns(co, p.id, sns))) throw httpErr(409, 'Some serial numbers of ' + p.name + ' are no longer in stock.');
        taken.push({ ser: true, id: p.id, sns }); out.push({ ...base, ser: true, qty: sns.length, sns });
      } else {
        const qty = Math.floor(Number(it.qty));
        if (!(qty > 0)) throw httpErr(400, 'Enter a quantity for ' + p.name + '.');
        if (!(await st.takeQty(co, p.id, qty))) throw httpErr(409, 'There is not enough stock of ' + p.name + '.');
        taken.push({ id: p.id, qty }); out.push({ ...base, qty });
      }
    }
  } catch (e) {
    for (const t of taken) { if (t.ser) await st.giveSns(co, t.id, t.sns); else await st.giveQty(co, t.id, t.qty); }
    throw e;
  }
  const no = await st.nextNo(co), t = { id: ctx.uid(), co, no, ts: ctx.now(), at: ctx.now(), by, from, to, items: out, note: String(note || '').slice(0, 300), status: 'pending' };
  await st.addTrf(t);
  const mv = [];
  for (const it of out) mv.push(mvDoc(ctx, co, from, { id: it.id, name: it.name }, -it.qty, 'TRF-' + no + ' sent', it.sns ? it.sns.join(', ').slice(0, 200) : '', by, await st.stockOf(co, it.id)));
  await st.addMoves(mv);
  return t;
}

// The receiving branch accepts: the goods are added to its stock.
async function acceptTransfer(st, ctx, { co, id, by, note }) {
  const t = await st.claim(co, id, 'pending', 'accepted', { decidedBy: by, decidedAt: ctx.now(), decNote: String(note || '').slice(0, 300) });
  if (!t) throw httpErr(409, 'This transfer has already been handled.');
  const mv = [];
  try {
    for (const it of t.items) { const p = await receive(st, ctx, co, t.to, it); mv.push(mvDoc(ctx, co, t.to, p, it.qty, 'TRF-' + t.no + ' received', it.sns ? it.sns.join(', ').slice(0, 200) : '', by, await st.stockOf(co, p.id))); }
  } catch (e) { await st.claim(co, id, 'accepted', 'pending', { decidedBy: '', decidedAt: 0 }); throw e; }   // undo the claim so it can be retried
  await st.addMoves(mv);
  return t;
}

// Declined or cancelled: the goods go back into the sending branch.
async function returnTransfer(st, ctx, { co, id, by, note, status }) {
  const t = await st.claim(co, id, 'pending', status, { decidedBy: by, decidedAt: ctx.now(), decNote: String(note || '').slice(0, 300) });
  if (!t) throw httpErr(409, 'This transfer has already been handled.');
  const mv = [];
  for (const it of t.items) { const p = await receive(st, ctx, co, t.from, it); mv.push(mvDoc(ctx, co, t.from, p, it.qty, 'TRF-' + t.no + ' ' + status + ', returned', it.sns ? it.sns.join(', ').slice(0, 200) : '', by, await st.stockOf(co, p.id))); }
  await st.addMoves(mv);
  return t;
}

module.exports = { createTransfer, acceptTransfer, returnTransfer, receive, httpErr, rxEsc };
