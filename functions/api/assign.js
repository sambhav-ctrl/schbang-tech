// functions/api/assign.js
// GET  /api/assign?brand=xxx        → get assignment for a brand
// POST /api/assign { brand, gam, am } → save assignment

export async function onRequest(context) {
  const { request, env } = context;
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };

  if (request.method === 'OPTIONS') return new Response(null, { headers });

  try {
    if (request.method === 'GET') {
      // Return all assignments
      const { keys } = await env.PUSH_SUBS.list({ prefix: 'assign_' });
      const assignments = {};
      await Promise.all(keys.map(async ({ name }) => {
        const val = await env.PUSH_SUBS.get(name);
        if (val) {
          const brand = decodeURIComponent(name.replace('assign_', ''));
          assignments[brand] = JSON.parse(val);
        }
      }));
      return new Response(JSON.stringify({ assignments }), { headers });
    }

    if (request.method === 'POST') {
      const { brand, gam, am } = await request.json();
      if (!brand || !gam || !am) return new Response(JSON.stringify({ error: 'Missing fields' }), { status: 400, headers });
      const key = 'assign_' + encodeURIComponent(brand.toLowerCase().trim());
      await env.PUSH_SUBS.put(key, JSON.stringify({ gam, am }));
      return new Response(JSON.stringify({ ok: true, brand, gam, am }), { headers });
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
  } catch(err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}
