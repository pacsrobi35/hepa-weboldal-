import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.115.0";
import { Webhook } from "npm:svix@2.5.0";

const MAX_BODY_BYTES = 256_000;
const TRACKED_EVENTS = new Set([
  "email.sent",
  "email.delivery_delayed",
  "email.delivered",
  "email.bounced",
  "email.failed",
  "email.complained",
  "email.suppressed",
]);

type UnknownRecord = Record<string, unknown>;

function json(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") {
    return json({ ok: false, code: "method-not-allowed" }, 405);
  }

  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return json({ ok: false, code: "payload-too-large" }, 413);
  }

  const svixId = nonEmptyString(request.headers.get("svix-id"));
  const svixTimestamp = nonEmptyString(request.headers.get("svix-timestamp"));
  const svixSignature = nonEmptyString(request.headers.get("svix-signature"));
  const webhookSecret = Deno.env.get("RESEND_WEBHOOK_SECRET")?.trim();

  if (!webhookSecret) {
    console.error("resend webhook secret is missing");
    return json({ ok: false, code: "webhook-unavailable" }, 503);
  }
  if (!svixId || !svixTimestamp || !svixSignature) {
    return json({ ok: false, code: "signature-headers-missing" }, 400);
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return json({ ok: false, code: "body-unreadable" }, 400);
  }
  if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
    return json({ ok: false, code: "payload-too-large" }, 413);
  }

  let event: UnknownRecord;
  try {
    const verified = new Webhook(webhookSecret).verify(rawBody, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    });
    const record = asRecord(verified);
    if (!record) throw new Error("invalid-event-shape");
    event = record;
  } catch {
    return json({ ok: false, code: "invalid-signature" }, 400);
  }

  const eventType = nonEmptyString(event.type);
  if (!eventType || !TRACKED_EVENTS.has(eventType)) {
    return json({ ok: true, state: "ignored_event_type" }, 200);
  }

  const data = asRecord(event.data);
  const providerMessageId = nonEmptyString(data?.email_id);
  const rawCreatedAt = nonEmptyString(event.created_at);
  const createdAt = rawCreatedAt ? new Date(rawCreatedAt) : null;

  if (
    !providerMessageId || providerMessageId.length > 200 ||
    !createdAt || Number.isNaN(createdAt.getTime())
  ) {
    return json({ ok: false, code: "invalid-event" }, 400);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    console.error("resend webhook database configuration is missing");
    return json({ ok: false, code: "webhook-unavailable" }, 503);
  }

  const serviceSupabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const payloadSha256 = await sha256(rawBody);
  const { data: result, error } = await serviceSupabase.rpc(
    "record_quote_offer_provider_event",
    {
      p_svix_id: svixId,
      p_provider_message_id: providerMessageId,
      p_event_type: eventType,
      p_event_created_at: createdAt.toISOString(),
      p_payload_sha256: payloadSha256,
    },
  );

  if (error) {
    console.error("resend webhook persistence failed", error.code ?? "unknown");
    return json({ ok: false, code: "persistence-failed" }, 500);
  }

  const state = nonEmptyString(asRecord(result)?.state) ?? "recorded";
  return json({ ok: true, state }, 200);
});

