import { createClient } from "npm:@supabase/supabase-js@2.115.0";

// This intentionally public key only gates the collector's intended website client.
// It does not grant access to stored events or to customer submissions.
const websitePublishableKey = "sb_publishable_DPpJ2bkxAvoo6Xqp_gDi2g_oGRNIIbl";
const allowedOrigins = new Set(["https://hepabutor.hu", "https://www.hepabutor.hu"]);
const events = new Set(["cta_click", "form_view", "form_start", "submit_attempt", "submit_success"]);
const funnels = new Set(["callback", "cutting"]);
const pages = new Set(["/", "/index.html", "/konyhabutor.html", "/lapszabaszat.html", "/lapszabaszat-ajanlatkeres.html"]);
const devices = new Set(["mobile", "desktop"]);
const allowedKeys = new Set(["sessionToken", "event", "funnel", "page", "device", "submissionToken"]);
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const maxBodyBytes = 1024;

function response(status: number, origin?: string) {
  const headers: Record<string, string> = {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "vary": "Origin",
  };
  if (origin && allowedOrigins.has(origin)) {
    headers["access-control-allow-origin"] = origin;
    headers["access-control-allow-methods"] = "POST, OPTIONS";
    headers["access-control-allow-headers"] = "content-type, apikey";
  }
  return new Response(status === 204 ? null : JSON.stringify({ ok: status < 400 }), { status, headers });
}

function acceptedApiKey(key: string | null) {
  if (!key) return false;
  if (key === websitePublishableKey) return true;
  // Supabase can provision publishable keys as a JSON object keyed by key name.
  try {
    const configured = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") || "{}");
    if (configured && typeof configured === "object" && Object.values(configured).includes(key)) return true;
  } catch { /* A missing/malformed optional key list must not open the endpoint. */ }
  return key === Deno.env.get("SUPABASE_ANON_KEY");
}

// Read incrementally: even a missing or forged Content-Length cannot allocate an
// arbitrary-sized body. No submitted customer fields or network IDs are retained.
async function smallJson(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("invalid-body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBodyBytes) {
      await reader.cancel();
      throw new Error("body-too-large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function validBody(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => !allowedKeys.has(key))) return false;
  if (typeof body.sessionToken !== "string" || !uuidV4.test(body.sessionToken)) return false;
  for (const [key, choices] of [["event", events], ["funnel", funnels], ["page", pages], ["device", devices]] as const) {
    if (typeof body[key] !== "string" || !choices.has(body[key] as string)) return false;
  }
  if (body.event === "submit_success") {
    return typeof body.submissionToken === "string" && uuidV4.test(body.submissionToken);
  }
  return !Object.hasOwn(body, "submissionToken");
}

Deno.serve(async (request: Request) => {
  const origin = request.headers.get("origin") || "";
  if (!allowedOrigins.has(origin)) return response(403);
  if (request.method === "OPTIONS") return response(204, origin);
  if (request.method !== "POST") return response(405, origin);
  if (!acceptedApiKey(request.headers.get("apikey"))) return response(401, origin);
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("content-type") || "")) {
    return response(415, origin);
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxBodyBytes)) {
    return response(413, origin);
  }
  let body: unknown;
  try {
    body = await smallJson(request);
  } catch (error) {
    return response(error instanceof Error && error.message === "body-too-large" ? 413 : 400, origin);
  }
  if (!validBody(body)) return response(400, origin);

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return response(503, origin);
  try {
    // Never forward the caller's Authorization header into the privileged client.
    const client = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error } = await client.rpc("record_lead_funnel_event", {
      p_session_token: body.sessionToken,
      p_event: body.event,
      p_funnel: body.funnel,
      p_page: body.page,
      p_device: body.device,
      p_submission_token: body.submissionToken || null,
    });
    if (error) return response(503, origin);
    // Same response for a duplicate, unverified success or recorded stage. The
    // public collector never discloses whether a customer token exists.
    return response(202, origin);
  } catch {
    return response(503, origin);
  }
});
