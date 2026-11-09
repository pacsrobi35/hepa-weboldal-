import { createClient } from "npm:@supabase/supabase-js@2.115.0";

const publicKey = "sb_publishable_DPpJ2bkxAvoo6Xqp_gDi2g_oGRNIIbl";
const origins = new Set(["https://hepabutor.hu", "https://www.hepabutor.hu"]);
const pages = new Set(["/", "/konyhabutor.html", "/lapszabaszat.html", "/lapszabaszat-ajanlatkeres.html"]);
const sources = new Set(["direct", "google_ads", "google_organic", "facebook", "instagram", "bing", "referral", "other_campaign"]);
const categories = ["konyha", "gardrob", "eloszoba", "furdo", "nappali", "egyedi"];
const targets: Record<string, Set<string>> = {
  page_view: new Set([""]),
  section_view: new Set(["hero", "references", "process", "reviews", "service_area", "callback", "cutting_intro", "pricing", "faq"]),
  scroll_depth: new Set(["25", "50", "75", "90"]),
  engaged: new Set(["10", "30", "60", "120"]),
  cta_click: new Set(["callback", "cutting", "phone", "email", "directions"]),
  reference_view: new Set([...categories, "showcase"]),
  details_open: new Set(["faq", "project", "gallery", "optional"]),
  form_view: new Set(["callback", "cutting"]),
  form_start: new Set(["callback", "cutting"]),
  form_step: new Set(["choose", ...["manual:items", "manual:logistics", "manual:contact", "manual:review", "upload:details", "upload:logistics", "upload:contact", "upload:review", "help:details", "help:contact", "help:review"]]),
  validation_error: new Set(["name", "phone", "city", "email", "privacy", "file", "items", "material", "delivery", "description", "form"]),
  submit_attempt: new Set(["callback", "cutting"]),
  submit_error: new Set(["network", "timeout", "server", "rejected", "file", "unknown"]),
  submit_success: new Set(["callback", "cutting"]),
  resource_error: new Set(["image", "script", "style"]),
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function validBatch(body: unknown): body is Record<string, any> {
  if (!object(body) || !keys(body, ["sessionToken", "pageViewId", "page", "source", "campaignId", "device", "isTest", "events"])) return false;
  if (typeof body.sessionToken !== "string" || !uuid.test(body.sessionToken)
    || typeof body.pageViewId !== "string" || !uuid.test(body.pageViewId)
    || !pages.has(String(body.page)) || !sources.has(String(body.source))
    || !["mobile", "desktop"].includes(String(body.device)) || typeof body.isTest !== "boolean"
    || typeof body.campaignId !== "string" || !/^(?:[0-9]{1,20})?$/.test(body.campaignId)
    || !Array.isArray(body.events) || !body.events.length || body.events.length > 20) return false;
  return body.events.every((e: unknown) => object(e)
    && keys(e, ["id", "type", "target", "funnel", "value", "sequence", "submissionToken"])
    && typeof e.id === "string" && uuid.test(e.id)
    && typeof e.type === "string" && typeof e.target === "string" && targets[e.type]?.has(e.target)
    && ["", "callback", "cutting"].includes(String(e.funnel))
    && Number.isInteger(e.value) && Number(e.value) >= 0 && Number(e.value) <= 1800000
    && Number.isInteger(e.sequence) && Number(e.sequence) >= 0 && Number(e.sequence) <= 1000000
    && (e.type === "submit_success"
      ? (e.funnel === e.target && typeof e.submissionToken === "string" && uuid.test(e.submissionToken))
      : !Object.hasOwn(e, "submissionToken")));
}

function reply(status: number, origin: string, data: unknown = { ok: status < 400 }) {
  return new Response(status === 204 ? null : JSON.stringify(data), { status, headers: {
    "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "vary": "Origin",
    ...(origins.has(origin) ? { "access-control-allow-origin": origin, "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type, apikey, authorization, x-client-info" } : {}),
  } });
}

async function smallBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 16384) { await reader.cancel(); throw new Error(); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

Deno.serve(async (request: Request) => {
  const origin = request.headers.get("origin") || "";
  if (!origins.has(origin)) return reply(403, origin);
  if (request.method === "OPTIONS") return reply(204, origin);
  if (request.method !== "POST") return reply(405, origin);
  if (request.headers.get("apikey") !== publicKey) return reply(401, origin);
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("content-type") || "")) return reply(415, origin);
  let body;
  try { body = await smallBody(request); } catch { return reply(400, origin); }
  const url = Deno.env.get("SUPABASE_URL"), secret = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !secret) return reply(503, origin);
  // The public caller's headers are never attached to this privileged client.
  const client = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    if (object(body) && body.action === "report") {
      if (!keys(body, ["action", "days", "device", "source"]) || ![1, 7, 14, 30].includes(Number(body.days))
        || !["all", "mobile", "desktop"].includes(String(body.device))
        || !(body.source === "all" || sources.has(String(body.source)))) return reply(400, origin);
      const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      if (!token) return reply(401, origin);
      const { data: verified, error: userError } = await client.auth.getUser(token);
      if (userError || !verified.user) return reply(401, origin);
      // getClaims verifies the JWT signature/expiry; an unverified decoded claim is never trusted.
      const { data: claims, error: claimsError } = await client.auth.getClaims(token);
      if (claimsError || claims?.claims?.aal !== "aal2" || claims.claims.sub !== verified.user.id) return reply(403, origin);
      const { data: member, error: memberError } = await client.from("admin_users").select("user_id").eq("user_id", verified.user.id).maybeSingle();
      if (memberError || !member) return reply(403, origin);
      const { data, error } = await client.rpc("get_visitor_measurement_report", { p_days: Number(body.days), p_device: body.device, p_source: body.source });
      return error ? reply(503, origin) : reply(200, origin, { ok: true, report: data });
    }
    if (!validBatch(body)) return reply(400, origin);
    const { error } = await client.rpc("record_visitor_measurement", { p_batch: body });
    // No per-token result: public callers cannot probe whether an inquiry exists.
    return reply(error ? 503 : 202, origin);
  } catch { return reply(503, origin); }
});
