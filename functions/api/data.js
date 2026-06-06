// ============================================================
//  BILLING DASHBOARD — Cloudflare Pages Function
//  File: functions/api/data.js
// ============================================================

const MONTH_ORDER = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];

const HIERARCHY = {
  tech: {
    'Akshay': {
      'Bhargava': ['fevicreate','lnt realty'],
      'Jayesh':   ['loreal','shriram life'],
      'Tanisha':  ['cadilla','glow','bridgestone','reddy','better bath','dhp','usv'],
      'Tarini':   ['britannia']
    },
    'Carolyn': {
      'Aqib':   ['hccb','jindal stainless'],
      'Ritesh': ['birla opus','bodycraft'],
      'Khushi': ['amazon','ring','vantara']
    },
    'Melissa': {
      'Priyam': ['brookfield','figaro','himatsingka','nanhi kali']
    }
  },
  martech: {
    'Akshay': {
      'Bhargava': ['fevicreate','audi'],
      'Tanisha':  ['dominos','bridgestone'],
      'Tarini':   ['britannia','jiostar']
    },
    'Carolyn': {
      'Khushi': ['mccain'],
      'Ritesh': ['bodycraft','aditya birla']
    },
    'Melissa': {
      'Priyam':  ['milton','treo','procook','brookfield'],
      'Vibhuti': ['jockey','mahindra rise','kotak','nivea','castrol'],
      'Minal':   ['mom store','hdfc life','motorola']
    }
  }
};

const APR_EXCEPTIONS = {
  tech:    ["britannia","jindal stainless"],
  martech: ["britannia"]
};

function parseAmt(val) {
  return parseFloat(String(val||"").replace(/,/g,"")) || 0;
}
function norm(s) { return String(s||"").toLowerCase().trim(); }

function monthSortKey(name) {
  const s = norm(name).replace(/['\s]/g,"");
  for (let i = 0; i < MONTH_ORDER.length; i++) {
    if (s.startsWith(MONTH_ORDER[i])) {
      const yr = s.replace(MONTH_ORDER[i],"").replace("26","2026").replace("27","2027") || "2026";
      return parseInt(yr)*100+i;
    }
  }
  return 9999;
}

function findOwner(brandName, dept) {
  const h = HIERARCHY[dept] || {};
  const b = norm(brandName);
  for (const gam of Object.keys(h)) {
    for (const am of Object.keys(h[gam])) {
      if ((h[gam][am]||[]).some(k => b.includes(k) || k.includes(b))) return { gam, am };
    }
  }
  return { gam: "Unassigned", am: "Unassigned" };
}

async function fetchSheet(sheetId, tabName, apiKey, lastCol) {
  const range = encodeURIComponent(`'${tabName}'!A:${lastCol||'F'}`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}?key=${apiKey}`;
  const res = await fetch(url);
  const data = await res.json();
  return data.values || [];
}

async function fetchSheetMeta(sheetId, apiKey) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?key=${apiKey}&fields=sheets.properties.title`;
  const res = await fetch(url);
  const data = await res.json();
  return (data.sheets||[]).map(s => s.properties.title);
}

async function getUnbilledRows(sheetId, tabName, apiKey) {
  const rows = await fetchSheet(sheetId, tabName, apiKey, 'C');
  const map = {};
  let started = false;
  for (const row of rows) {
    if (!started) { if (norm(row[0]) === "retainer") { started = true; continue; } continue; }
    const brand = String(row[0]||"").trim();
    const amount = parseAmt(row[1]);
    const comment = String(row[2]||"").trim();
    if (!brand || norm(brand) === "total" || !amount) continue;
    map[norm(brand)] = { brand, amount, comment: comment || "No comment — pending" };
  }
  return map;
}

async function getEstimateMap(sheetId, tabName, dept, apiKey, isApril) {
  const map = {};
  if (isApril) {
    (APR_EXCEPTIONS[dept]||[]).forEach(b => { map[b] = { status:"no", date:"", value:0 }; });
    return map;
  }
  const rows = await fetchSheet(sheetId, tabName, apiKey, 'F');
  let started = false;
  for (const row of rows) {
    if (!started) { if (norm(row[0]).includes("sbu")) { started = true; continue; } continue; }
    if (norm(row[0]) !== dept) continue;
    const brand = String(row[1]||"").trim();
    if (!brand) continue;
    map[norm(brand)] = { status: norm(row[3]) || "no", date: row[4]||"", value: parseAmt(row[5]) };
  }
  return map;
}

// ── New VAS: reads from dept-specific tabs in the summary sheet ─
async function getVASData(vasSheetId, dept, apiKey) {
  const D = dept === "tech" ? "tech" : "martech";
  let tabs = [];
  try { tabs = await fetchSheetMeta(vasSheetId, apiKey); } catch(e) {}

  // Status tab: exact "Tech"/"Martech" (short name, few columns)
  const statusTab = tabs.find(t => norm(t) === D)
    || (dept === "tech" ? "Tech" : "Martech");
  // Detail tab: contains dept + "vas" + "2627" (current FY)
  const detailTab = tabs.find(t => { const n = norm(t); return n.includes(D) && n.includes("vas") && n.includes("2627"); })
    || (dept === "tech" ? "TECH - unbilled vas - 2627" : "MARTECH - unbilled vas - 2627");
  // Last FY tab: contains dept + "vas" + "25-26"
  const lastTab = tabs.find(t => { const n = norm(t); return n.includes(D) && n.includes("vas") && (n.includes("25-26") || n.includes("2526")); })
    || (dept === "tech" ? "TECH - Unbilled vas - 25-26" : "MARTECH - Unbilled vas - 25-26");

  const [statusRows, detailRows, lastRows] = await Promise.all([
    fetchSheet(vasSheetId, statusTab, apiKey, 'F').catch(()=>[]),
    fetchSheet(vasSheetId, detailTab, apiKey, 'X').catch(()=>[]),
    fetchSheet(vasSheetId, lastTab,   apiKey, 'X').catch(()=>[])
  ]);

  // Build status lookup: estNo → { status, unbilledVAS, unbilledRetainer, approxDate, reason }
  // Status tab cols: A=EstNo, B=approxDate, C=Reason, D=UpdatedStatus, E=unbilledVAS, F=unbilledRetainer
  const statusMap = {};
  let sStarted = false;
  for (const row of statusRows) {
    if (!sStarted) {
      if (norm(row[0]).includes("estimate")) { sStarted = true; continue; }
      continue;
    }
    const estNo = String(row[0]||"").trim();
    if (!estNo) continue;
    statusMap[estNo] = {
      status:            norm(row[3]||""),
      unbilledVAS:       parseAmt(row[4]),
      unbilledRetainer:  parseAmt(row[5]),
      approxDate:        String(row[1]||"").trim(),
      reason:            String(row[2]||"").trim()
    };
  }

  // Detail tab cols: A=EstNo, E=PrimaryGSM(AM), F=VPName(GAM), H=Brand, K=Notes, X=Month
  // Use amounts from statusMap (already pre-computed)
  const currentData = {};
  let dStarted = false;
  for (const row of detailRows) {
    if (!dStarted) {
      if (norm(row[0]).includes("estimate")) { dStarted = true; continue; }
      continue;
    }
    const estNo = String(row[0]||"").trim();
    if (!estNo) continue;
    const s = statusMap[estNo];
    if (!s || s.status !== "unbilled") continue;

    const brand  = String(row[7]||"").trim();   // Col H
    if (!brand) continue;

    const gam    = String(row[5]||"").trim();   // Col F = VP Name
    const am     = String(row[4]||"").trim();   // Col E = Primary GSM
    const notes  = String(row[10]||"").trim();  // Col K = Notes
    const month  = String(row[23]||"").trim();  // Col X = Month

    const key = norm(brand);
    if (!currentData[key]) currentData[key] = {
      brand,
      sheetGAM:      gam || "",
      sheetAM:       am  || "",
      entries:       [],
      total:         0,
      totalRetainer: 0
    };
    if (s.unbilledVAS > 0) {
      currentData[key].entries.push({ balVAS: s.unbilledVAS, estNo, notes, period: month, brand, approxDate: s.approxDate, reason: s.reason });
      currentData[key].total += s.unbilledVAS;
    }
    if (s.unbilledRetainer > 0) {
      currentData[key].totalRetainer += s.unbilledRetainer;
    }
  }

  // Last FY: cols A=EstDate, C=EstNo, D=EstAmt, G=BrandName, W=balanceLeft
  const lastData = {};
  let lStarted = false;
  for (const row of lastRows) {
    if (!lStarted) {
      if (norm(row[0]).includes("estimate")) { lStarted = true; continue; }
      continue;
    }
    const brand   = String(row[6]||"").trim();  // Col G
    const balance = parseAmt(row[22]);           // Col W
    const estNo   = String(row[2]||"").trim();   // Col C
    const estAmt  = parseAmt(row[3]);
    if (!brand || balance < 100) continue;
    const key = norm(brand);
    if (!lastData[key]) lastData[key] = { total: 0, entries: [] };
    lastData[key].total   += balance;
    lastData[key].entries.push({ brand, estNo, estAmt, balance });
  }

  return { currentData, lastData };
}

// ── Summary tab reader for charts ────────────────────────────
async function getSummaryData(vasSheetId, apiKey) {
  // Find the Summary tab by fuzzy match (handles trailing spaces / case)
  let summaryTab = 'Summary';
  try {
    const tabs = await fetchSheetMeta(vasSheetId, apiKey);
    const found = tabs.find(t => norm(t) === 'summary') || tabs.find(t => norm(t).includes('summary'));
    if (found) summaryTab = found;
  } catch(e) {}

  const rows = await fetchSheet(vasSheetId, summaryTab, apiKey, 'O');

  // Totals from row index 1
  const r1 = rows[1] || [];
  const totals = {
    techCurrentFY:    parseAmt(r1[5]),   // F
    martechCurrentFY: parseAmt(r1[8]),   // I
    techLastFY:       parseAmt(r1[11]),  // L
    martechLastFY:    parseAmt(r1[14])   // O
  };

  const monthlyUnbilled = [];
  const estInvRatio     = [];
  let inRatio = false;

  for (let i = 2; i < rows.length; i++) {
    const row  = rows[i];
    const col4 = String(row[4]||"").trim();
    if (!col4) continue;

    const c4n = col4.toLowerCase();

    // Detect ratio section
    if (c4n.includes("est") && c4n.includes("inv")) { inRatio = true; continue; }

    if (inRatio) {
      // Skip header row
      if (c4n.includes("martech") || c4n.includes("tech")) continue;
      if (!col4.match(/\d{4}/)) continue;
      estInvRatio.push({
        month:        col4,
        martechEst:   parseAmt(row[5]),
        martechInv:   parseAmt(row[6]),
        martechRatio: parseFloat(String(row[7]||"").replace('%','')) || 0,
        techEst:      parseAmt(row[10]),
        techInv:      parseAmt(row[11]),
        techRatio:    parseFloat(String(row[12]||"").replace('%','')) || 0
      });
    } else {
      if (c4n.includes("diff") || c4n.includes("tech") || c4n.includes("martech")) continue;
      if (!col4.match(/\d{4}/)) continue;
      monthlyUnbilled.push({
        month:            col4,
        techCurrentFY:    parseAmt(row[5]),
        martechCurrentFY: parseAmt(row[8]),
        techLastFY:       parseAmt(row[11]),
        martechLastFY:    parseAmt(row[14])
      });
    }
  }

  return { monthlyUnbilled, estInvRatio, totals, _debug: { tab: summaryTab, rowCount: rows.length } };
}

function mergeRows(unbilledMap, estMap, dept, isApril) {
  const allKeys = {};
  Object.keys(unbilledMap).forEach(k => allKeys[k] = true);
  Object.keys(estMap).forEach(k => allKeys[k] = true);
  return Object.keys(allKeys).map(key => {
    const u = unbilledMap[key], e = estMap[key];
    const status = isApril ? (e ? e.status : "yes") : (e ? e.status : "no");
    const owner = findOwner(u ? u.brand : key, dept);
    return { brand: u ? u.brand : key.replace(/\b\w/g, c => c.toUpperCase()),
      amount: u ? u.amount : 0, comment: u ? u.comment : "—",
      status, date: e?.date||"", value: e?.value||0, gam: owner.gam, am: owner.am };
  }).sort((a,b) => a.brand.localeCompare(b.brand));
}

function vasLookup(vasData, brandName) {
  const key = norm(brandName);
  const cKeys = Object.keys(vasData.currentData).filter(k => k.includes(key)||key.includes(k));
  const lKeys = Object.keys(vasData.lastData).filter(k => k.includes(key)||key.includes(k));
  const lastBreakdown = {};
  lKeys.forEach(k => {
    const d = vasData.lastData[k];
    if (!d) return;
    d.entries.forEach(e => {
      const bKey = norm(e.brand);
      if (!lastBreakdown[bKey]) lastBreakdown[bKey] = { brand: e.brand, total: 0 };
      lastBreakdown[bKey].total += e.balance;
    });
  });
  const firstCKey = cKeys[0];
  const sheetGAM = firstCKey ? (vasData.currentData[firstCKey].sheetGAM || "") : "";
  const sheetAM  = firstCKey ? (vasData.currentData[firstCKey].sheetAM  || "") : "";
  return {
    entries:       cKeys.flatMap(k => vasData.currentData[k].entries),
    total:         cKeys.reduce((s,k) => s + vasData.currentData[k].total, 0),
    lastFY:        lKeys.reduce((s,k) => s + (vasData.lastData[k]?.total||0), 0),
    lastBreakdown: Object.values(lastBreakdown).sort((a,b) => b.total - a.total),
    sheetGAM, sheetAM
  };
}

// ── Entry point ───────────────────────────────────────────────
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const p   = Object.fromEntries(url.searchParams);
  const headers = { "Access-Control-Allow-Origin":"*", "Content-Type":"application/json", "Cache-Control":"public, max-age=60" };

  try {
    const dept        = p.dept || "tech";
    const API_KEY     = env.GOOGLE_API_KEY;
    const UNBILLED_ID = dept === "tech" ? env.TECH_UNBILLED_SHEET_ID : env.MARTECH_UNBILLED_SHEET_ID;
    const ESTIMATE_ID = env.ESTIMATE_SHEET_ID;
    const VAS_ID      = env.VAS_SHEET_ID;  // now points to new summary sheet

    // ── Diagnostic: list tabs in the VAS sheet ────────────────
    if (p.diag) {
      const tabs = VAS_ID ? await fetchSheetMeta(VAS_ID, API_KEY) : [];
      return new Response(JSON.stringify({ vasSheetId: VAS_ID || "(not set)", tabs }), { headers });
    }

    // ── Summary charts route ──────────────────────────────────
    if (p.summary) {
      const data = await getSummaryData(VAS_ID, API_KEY);
      return new Response(JSON.stringify(data), { headers });
    }

    // ── Tabs list ─────────────────────────────────────────────
    if (!p.month && !p.search) {
      const [ut, et] = await Promise.all([fetchSheetMeta(UNBILLED_ID, API_KEY), fetchSheetMeta(ESTIMATE_ID, API_KEY)]);
      const seen={}, tabs=[];
      [...ut,...et].forEach(n => { if (!seen[n]) { seen[n]=true; tabs.push(n); } });
      tabs.sort((a,b) => monthSortKey(a)-monthSortKey(b));
      return new Response(JSON.stringify({ tabs }), { headers });
    }

    // ── Search ────────────────────────────────────────────────
    if (p.search) {
      const query = norm(p.search);
      const [ut, et, vasData] = await Promise.all([
        fetchSheetMeta(UNBILLED_ID, API_KEY),
        fetchSheetMeta(ESTIMATE_ID, API_KEY),
        VAS_ID ? getVASData(VAS_ID, dept, API_KEY) : Promise.resolve({ currentData:{}, lastData:{} })
      ]);
      const seen={}, allTabs=[];
      [...ut,...et].forEach(n => { if (!seen[n]) { seen[n]=true; allTabs.push(n); } });
      allTabs.sort((a,b) => monthSortKey(a)-monthSortKey(b));

      const monthData = await Promise.all(allTabs.map(async tab => {
        const isApril = norm(tab).replace(/[\s']/g,"").includes("apr");
        const [um, em] = await Promise.all([
          getUnbilledRows(UNBILLED_ID, tab, API_KEY).catch(()=>({})),
          getEstimateMap(ESTIMATE_ID, tab, dept, API_KEY, isApril).catch(()=>({}))
        ]);
        return { tab, rows: mergeRows(um, em, dept, isApril) };
      }));

      const brandMap = {};
      for (const { tab, rows } of monthData) {
        for (const row of rows) {
          if (norm(row.brand).includes(query) || query.includes(norm(row.brand))) {
            const key = norm(row.brand);
            if (!brandMap[key]) brandMap[key] = { brand: row.brand, gam: row.gam, am: row.am, months: [] };
            brandMap[key].months.push({ month: tab, retainer: row.amount, comment: row.comment, status: row.status, date: row.date, value: row.value });
          }
        }
      }

      // Also include brands found only in VAS data
      const allVASBrands = [...Object.keys(vasData.currentData), ...Object.keys(vasData.lastData)];
      for (const vasKey of allVASBrands) {
        const vasEntry = vasData.currentData[vasKey] || vasData.lastData[vasKey];
        const brandName = vasEntry?.brand || vasEntry?.entries?.[0]?.brand || vasKey;
        if (norm(brandName).includes(query) || query.includes(norm(brandName))) {
          const key = norm(brandName);
          if (!brandMap[key]) {
            const owner = findOwner(brandName, dept);
            brandMap[key] = { brand: brandName, gam: owner.gam, am: owner.am, months: [] };
          }
        }
      }

      // KV assignments
      let kvAssignments = {};
      try {
        const { keys: aKeys } = await env.PUSH_SUBS.list({ prefix: 'assign_' });
        await Promise.all(aKeys.map(async ({ name }) => {
          const val = await env.PUSH_SUBS.get(name);
          if (val) kvAssignments[decodeURIComponent(name.replace('assign_',''))] = JSON.parse(val);
        }));
      } catch(e) {}

      const results = Object.values(brandMap).map(b => {
        const v   = vasLookup(vasData, b.brand);
        const kvKey = norm(b.brand);
        const kv    = kvAssignments[kvKey] || null;
        // GAM/AM: sheet VP Name > KV assignment > hierarchy fallback
        const gam = v.sheetGAM || kv?.gam || b.gam || "Unassigned";
        const am  = v.sheetAM  || kv?.am  || b.am  || "Unassigned";
        return { ...b, gam, am,
          currentVAS: v.entries, currentVASTotal: v.total,
          lastFYBalance: v.lastFY, lastBreakdown: v.lastBreakdown,
          needsAssignment: (!v.sheetGAM && !v.sheetAM && (gam === "Unassigned" || am === "Unassigned"))
        };
      });

      return new Response(JSON.stringify({ results }), { headers });
    }

    // ── Month ─────────────────────────────────────────────────
    const month   = p.month;
    const isApril = norm(month).replace(/[\s']/g,"").includes("apr");
    const [um, em, vasData] = await Promise.all([
      getUnbilledRows(UNBILLED_ID, month, API_KEY).catch(()=>({})),
      getEstimateMap(ESTIMATE_ID, month, dept, API_KEY, isApril).catch(()=>({})),
      VAS_ID ? getVASData(VAS_ID, dept, API_KEY) : Promise.resolve({ currentData:{}, lastData:{} })
    ]);
    const rows            = mergeRows(um, em, dept, isApril);
    const vasCurrentTotal = Object.values(vasData.currentData).reduce((s,v) => s+v.total, 0);
    const vasLastTotal    = Object.values(vasData.lastData).reduce((s,v) => s+(v?.total||0), 0);

    const vasBrands = Object.values(vasData.currentData).map(v => {
      const lKeys = Object.keys(vasData.lastData).filter(k => k.includes(norm(v.brand)) || norm(v.brand).includes(k));
      const lastFY = lKeys.reduce((s,k) => s + (vasData.lastData[k]?.total||0), 0);
      // GAM/AM: sheet > hierarchy fallback
      const owner = findOwner(v.brand, dept);
      const gam = v.sheetGAM || owner.gam;
      const am  = v.sheetAM  || owner.am;
      return { brand: v.brand, gam, am, currentVAS: v.total, lastFY };
    }).filter(v => v.currentVAS > 0);

    return new Response(JSON.stringify({ rows, month, hierarchy: HIERARCHY[dept]||{}, vasCurrentTotal, vasLastTotal, vasBrands }), { headers });

  } catch(err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}
