// functions/api/subscribe.js — stores push subscription in KV, scoped to this dept
export async function onRequest(context) {
  const { request, env } = context;
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  if (request.method === 'OPTIONS') return new Response(null, { headers });
  try {
    const sub = await request.json();
    if (!sub?.endpoint) return new Response(JSON.stringify({ error: 'No endpoint' }), { status: 400, headers });
    const key = 'subtech_' + btoa(sub.endpoint).replace(/[^a-z0-9]/gi,'').slice(0,32);
    await env.PUSH_SUBS.put(key, JSON.stringify(sub), { expirationTtl: 60 * 60 * 24 * 60 });
    return new Response(JSON.stringify({ ok: true }), { headers });
  } catch(err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}
