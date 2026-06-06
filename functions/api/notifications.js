// functions/api/notifications.js
// Returns the latest notification stored in KV.
// Accepts ?dept=tech|martech to return that dept's message specifically.
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const dept = url.searchParams.get('dept');
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  try {
    let latest = null;
    if (dept) {
      latest = await env.PUSH_SUBS.get('latest_notification_' + dept);
    }
    // Fallback to shared key if no dept-specific message
    if (!latest) latest = await env.PUSH_SUBS.get('latest_notification');
    return new Response(JSON.stringify({ latest: latest ? JSON.parse(latest) : null }), { headers });
  } catch(err) {
    return new Response(JSON.stringify({ latest: null }), { headers });
  }
}
