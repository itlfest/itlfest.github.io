const encoder = new TextEncoder();
const announcementSuffix = "のお客様、お待たせいたしました。商品をお受け取りください。";

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  if (origin !== env.ALLOWED_ORIGIN) return null;

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
}

function response(body, status, headers = {}) {
  return new Response(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

function announcementText(numbers) {
  if (!Array.isArray(numbers) || !numbers.length || numbers.length > 20) return null;

  const normalized = numbers.map((number) => String(number));
  if (normalized.some((number) => !/^\d{1,4}$/.test(number))) return null;
  return `${normalized.map((number) => `${number}番`).join("、")}${announcementSuffix}`;
}

async function signature(secret, timestamp, body) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const result = await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}${body}`));
  return [...new Uint8Array(result)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (!cors) return response("Forbidden", 403);
    if (request.method === "OPTIONS") return response(null, 204, cors);
    if (request.method !== "POST") return response("Method Not Allowed", 405, cors);
    if (!env.COEFONT_ACCESS_KEY || !env.COEFONT_ACCESS_SECRET || !env.COEFONT_ID) {
      return response("Worker is not configured", 503, cors);
    }

    let input;
    try {
      input = await request.json();
    } catch {
      return response("Invalid JSON", 400, cors);
    }

    const text = announcementText(input.numbers);
    if (!text) return response("Invalid numbers", 400, cors);

    const payload = JSON.stringify({
      coefont: env.COEFONT_ID,
      text,
      speed: 0.9,
      format: "mp3"
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signed = await signature(env.COEFONT_ACCESS_SECRET, timestamp, payload);
    const coefontResponse = await fetch("https://api.coefont.cloud/v2/text2speech", {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/json",
        "Authorization": env.COEFONT_ACCESS_KEY,
        "X-Coefont-Date": timestamp,
        "X-Coefont-Content": signed
      },
      body: payload
    });

    const audioUrl = coefontResponse.headers.get("Location");
    if (coefontResponse.status !== 302 || !audioUrl) {
      console.error("CoeFont request failed", { status: coefontResponse.status });
      return response("CoeFont request failed", 502, cors);
    }

    const audioResponse = await fetch(audioUrl);
    if (!audioResponse.ok) {
      console.error("CoeFont audio download failed", { status: audioResponse.status });
      return response("CoeFont audio download failed", 502, cors);
    }

    return new Response(audioResponse.body, {
      headers: {
        ...cors,
        "Cache-Control": "no-store",
        "Content-Type": audioResponse.headers.get("Content-Type") ?? "audio/mpeg"
      }
    });
  }
};
