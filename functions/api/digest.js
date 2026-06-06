// functions/api/digest.js
// Computes the weekly reminder: a teaser line (for push) + full summary (for banner).
// Reused by both the push sender and the in-app "since you last looked" banner.
//
// GET  /api/digest?dept=tech            → { teaser, summary, snapshot }
// POST /api/digest?dept=tech&send=1     → also pushes to all stored subscriptions

function parseAmt(v){ return parseFloat(String(v||"").replace(/,/g,"")) || 0; }
function norm(s){ return String(s||"").toLowerCase().trim(); }
function fmtK(v){
  v = Math.round(v);
  if (Math.abs(v) >= 10000000) return '₹' + (v/10000000).toFixed(2) + 'Cr';
  if (Math.abs(v) >= 100000)   return '₹' + (v/100000).toFixed(1) + 'L';
  if (Math.abs(v) >= 1000)     return '₹' + (v/1000).toFixed(0) + 'k';
  return '₹' + v;
}

async function fetchSheet(sheetId, tabName, apiKey, lastCol){
  const range = encodeURIComponent(`'${tabName}'!A:${lastCol||'F'}`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}?key=${apiKey}`;
  const res = await fetch(url);
  const data = await res.json();
  return data.values || [];
}
async function fetchSheetMeta(sheetId, apiKey){
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?key=${apiKey}&fields=sheets.properties.title`;
  const res = await fetch(url);
  const data = await res.json();
  return (data.sheets||[]).map(s => s.properties.title);
}

// Days between an estimate/approx date string and now
function parseDate(dateStr){
  if(!dateStr) return null;
  const s=String(dateStr).trim();
  // Try DD-MM-YYYY or DD/MM/YYYY (Indian format) first
  let m=s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})$/);
  if(m){
    let [_,d,mo,y]=m; y=y.length===2?'20'+y:y;
    const dt=new Date(+y,+mo-1,+d);
    if(!isNaN(dt)) return dt;
  }
  // Try DD-MonthName-YYYY (e.g. 05-Apr-2026, 5 April 2026)
  const months={jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
  m=s.toLowerCase().match(/(\d{1,2})[\s-]+([a-z]{3,})[\s-]+(\d{2,4})/);
  if(m){
    const mo=months[m[2].slice(0,3)];
    if(mo!=null){ let y=m[3].length===2?'20'+m[3]:m[3]; const dt=new Date(+y,mo,+m[1]); if(!isNaN(dt)) return dt; }
  }
  // Fallback: native parse (handles ISO YYYY-MM-DD)
  const dt=new Date(s);
  return isNaN(dt)?null:dt;
}
function daysSince(dateStr){
  const d=parseDate(dateStr);
  if(!d) return null;
  return Math.floor((Date.now()-d.getTime())/86400000);
}

// Build the snapshot of current unbilled VAS state
async function buildSnapshot(env, dept){
  const apiKey = env.GOOGLE_API_KEY;
  const vasId  = env.VAS_SHEET_ID;
  if (!vasId) return null;

  const D = dept === "tech" ? "tech" : "martech";
  let tabs = [];
  try { tabs = await fetchSheetMeta(vasId, apiKey); } catch(e){}

  const statusTab = tabs.find(t => norm(t) === D) || (dept==="tech"?"Tech":"Martech");
  const detailTab = tabs.find(t => { const n=norm(t); return n.includes(D)&&n.includes("vas")&&n.includes("2627"); })
    || (dept==="tech"?"TECH - unbilled vas - 2627":"MARTECH - unbilled vas - 2627");

  const [statusRows, detailRows] = await Promise.all([
    fetchSheet(vasId, statusTab, apiKey, 'F').catch(()=>[]),
    fetchSheet(vasId, detailTab, apiKey, 'X').catch(()=>[])
  ]);

  // status: estNo → {status, vas, approxDate, reason}
  const statusMap = {};
  let s=false;
  for (const r of statusRows){
    if(!s){ if(norm(r[0]).includes("estimate")){s=true;} continue; }
    const e=String(r[0]||"").trim(); if(!e) continue;
    statusMap[e]={ status:norm(r[3]), vas:parseAmt(r[4]), approxDate:String(r[1]||"").trim(), reason:String(r[2]||"").trim() };
  }

  const items=[];
  let d=false;
  for (const r of detailRows){
    if(!d){ if(norm(r[0]).includes("estimate")){d=true;} continue; }
    const e=String(r[0]||"").trim(); if(!e) continue;
    const st=statusMap[e];
    if(!st || st.status!=="unbilled" || st.vas<=0) continue;
    const estDate=String(r[3]||"").trim();
    items.push({
      estNo:e, brand:String(r[7]||"").trim(), vas:st.vas,
      estDate, approxDate:st.approxDate, reason:st.reason,
      age: daysSince(estDate),
      overdue: st.approxDate && daysSince(st.approxDate) > 0
    });
  }

  const total   = items.reduce((a,b)=>a+b.vas,0);
  const oldest  = items.filter(i=>i.age!=null).sort((a,b)=>b.age-a.age)[0] || null;
  const overdue = items.filter(i=>i.overdue);
  const top     = [...items].sort((a,b)=>b.vas-a.vas).slice(0,5);

  return {
    dept, count: items.length, total,
    oldestAge: oldest?oldest.age:null, oldestBrand: oldest?oldest.brand:null,
    overdueCount: overdue.length, overdueAmt: overdue.reduce((a,b)=>a+b.vas,0),
    top: top.map(i=>({brand:i.brand, vas:i.vas, age:i.age, estNo:i.estNo}))
  };
}

// Rotating teaser — states a fact, withholds the detail, so you must open the app
function buildTeaser(snap){
  const opts = [];
  if (snap.total > 0)
    opts.push(`${fmtK(snap.total)} is sitting unbilled this week. 👀 Tap to see what.`);
  if (snap.overdueCount > 0)
    opts.push(`${snap.overdueCount} estimate${snap.overdueCount>1?'s':''} blew past ${snap.overdueCount>1?'their':'its'} billing date. Open to chase.`);
  if (snap.oldestAge != null && snap.oldestAge > 0)
    opts.push(`Your oldest unbilled is now ${snap.oldestAge} days old. Tap to see which brand.`);
  if (snap.count > 0)
    opts.push(`${snap.count} unbilled estimate${snap.count>1?'s':''} are waiting on you. 🧾`);
  if (snap.top[0])
    opts.push(`One brand alone is holding ${fmtK(snap.top[0].vas)} unbilled. Open to find out who.`);
  if (!opts.length) opts.push(`Weekly check-in: tap to review your billing.`);

  // Rotate by week-of-year so the message changes each week
  const week = Math.floor(Date.now() / (7*86400000));
  return opts[week % opts.length];
}

function buildSummary(snap){
  if (!snap || snap.count === 0) return "Nothing unbilled right now. 🎉";
  const lines = [];
  lines.push(`${fmtK(snap.total)} unbilled across ${snap.count} estimate${snap.count>1?'s':''}.`);
  if (snap.overdueCount > 0) lines.push(`${snap.overdueCount} past their billing date (${fmtK(snap.overdueAmt)}).`);
  if (snap.oldestBrand)      lines.push(`Oldest: ${snap.oldestBrand}, ${snap.oldestAge} days.`);
  return lines.join(' ');
}

// ── VAPID push (mirrors notify.js) ────────────────────────────
function b64url(str){
  return btoa(typeof str==='string'?str:String.fromCharCode(...new Uint8Array(str)))
    .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}
async function vapidJWT(endpoint, privateJWK, subject){
  const origin=new URL(endpoint).origin;
  const exp=Math.floor(Date.now()/1000)+43200;
  const header=b64url(JSON.stringify({typ:'JWT',alg:'ES256'}));
  const payload=b64url(JSON.stringify({aud:origin,exp,sub:subject}));
  const toSign=`${header}.${payload}`;
  const key=await crypto.subtle.importKey('jwk',privateJWK,{name:'ECDSA',namedCurve:'P-256'},false,['sign']);
  const sig=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key,new TextEncoder().encode(toSign));
  return `${toSign}.${b64url(sig)}`;
}
async function sendPush(sub, vapidPublic, privateJWK, subject){
  try{
    const jwt=await vapidJWT(sub.endpoint, privateJWK, subject);
    const res=await fetch(sub.endpoint,{method:'POST',headers:{
      'Authorization':`vapid t=${jwt},k=${vapidPublic}`,'TTL':'86400','Content-Length':'0'
    }});
    return res.status;
  }catch(e){ return 0; }
}

async function pushToAll(env, title, body, dept){
  const id = 'weekly-' + Date.now();
  // Store per-dept so a tech push can't read a martech message (and vice-versa)
  const payload = JSON.stringify({ title, body, id, dept, ts: Date.now() });
  await env.PUSH_SUBS.put('latest_notification_' + dept, payload);
  // Also keep the shared key updated for backward compatibility
  await env.PUSH_SUBS.put('latest_notification', payload);

  const subject = 'mailto:billing@schbang.com';
  const { keys } = await env.PUSH_SUBS.list({ prefix: 'subtech_' });
  let sent = 0;
  const codes = [];
  await Promise.all(keys.map(async ({name}) => {
    const raw = await env.PUSH_SUBS.get(name);
    if (!raw) return;
    const sub = JSON.parse(raw);
    const code = await sendPush(sub, env.VAPID_PUBLIC_KEY, JSON.parse(env.VAPID_PRIVATE_JWK), subject);
    codes.push(code);
    if (code >= 200 && code < 300) sent++;
    // Prune dead/mismatched subscriptions so they don't linger
    else if (code === 403 || code === 404 || code === 410) { await env.PUSH_SUBS.delete(name); }
  }));
  return { sent, subCount: keys.length, codes };
}

export async function onRequest(context){
  const { request, env } = context;
  const url = new URL(request.url);
  const p = Object.fromEntries(url.searchParams);
  const headers = { "Access-Control-Allow-Origin":"*", "Content-Type":"application/json" };
  if (request.method === 'OPTIONS') return new Response(null, { headers });

  try {
    const dept = p.dept || "tech";

    // One-time cleanup: ?reset=1 deletes all stored subscriptions
    if (p.reset) {
      const { keys } = await env.PUSH_SUBS.list({ prefix: 'subtech_' });
      await Promise.all(keys.map(k => env.PUSH_SUBS.delete(k.name)));
      return new Response(JSON.stringify({ cleared: keys.length }), { headers });
    }

    const snap = await buildSnapshot(env, dept);
    const teaser  = snap ? buildTeaser(snap)  : "Weekly check-in: tap to review your billing.";
    const summary = buildSummary(snap);

    // If send=1, also fire the push (used by the cron / manual trigger)
    let pushed = null;
    if (p.send) {
      pushed = await pushToAll(env, "Schbang Billing 🔔", teaser, dept);
    }

    return new Response(JSON.stringify({ teaser, summary, snapshot: snap, pushed }), { headers });
  } catch(err){
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}
