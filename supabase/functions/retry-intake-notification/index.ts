import { createClient } from "npm:@supabase/supabase-js@2.115.0";

type DbClient = ReturnType<typeof createClient>;
type Quote = {
  id: number;
  request_kind: string;
  source: string;
  intake_state: string;
  notification_error: string | null;
  notification_sent_at: string | null;
  customer_name: string;
  email: string | null;
  phone: string | null;
  message: string | null;
  project_type: string | null;
  approximate_dimensions: string | null;
  wants_callback: boolean;
  wants_quote: boolean;
  wants_consultation: boolean;
};

function json(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function keyFromEnv(modern: string, legacy: string) {
  try {
    const values = JSON.parse(Deno.env.get(modern) || "{}") as Record<string, string>;
    if (typeof values.default === "string" && values.default) return values.default;
  } catch { /* Legacy keys may still be in use. */ }
  return Deno.env.get(legacy) ?? "";
}

function reference(quote: Quote) {
  return quote.request_kind === "cutting"
    ? `HEPA-LSZ-${String(quote.id).padStart(6, "0")}`
    : `HEPA-${String(quote.id).padStart(6, "0")}`;
}

function recipients(kind: string) {
  if (kind === "furniture") return ["hepaconstructkft@gmail.com"];
  const configured = Deno.env.get("QUOTE_NOTIFICATION_TO") || "hepaconstructkft@gmail.com";
  const addresses = configured.split(",").map((address) => address.trim())
    .filter((address) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address));
  return addresses.length ? addresses : ["hepaconstructkft@gmail.com"];
}

async function notificationBody(client: DbClient, quote: Quote) {
  const ref = reference(quote);
  const { data: files, error: fileError } = await client.from("quote_request_files")
    .select("original_name").eq("quote_request_id", quote.id).order("id");
  if (fileError) throw fileError;

  const lines = [
    "A weboldalon beérkezett ajánlatkérés értesítését most pótoltuk.",
    `Ügy: ${ref}`,
    `Megnyitás az ügyfélkezelőben: https://hepa-ugyfelkezeles.vercel.app/protected/megkeresesek/${ref}`,
    `Név: ${quote.customer_name}`,
    `Telefonszám: ${quote.phone || "nincs megadva"}`,
    `E-mail: ${quote.email || "nincs megadva"}`,
    `Megjegyzés: ${quote.message || "nincs megadva"}`,
    `Feltöltött fájlok: ${files?.map((file) => file.original_name).join(", ") || "nincsenek"}`,
  ];

  if (quote.request_kind === "furniture") {
    lines.push(
      `Bútortípus: ${quote.project_type || "nincs megadva"}`,
      `Méretek: ${quote.approximate_dimensions || "nincs megadva"}`,
      `Kapcsolatfelvétel: ${[
        quote.wants_callback ? "visszahívás" : "",
        quote.wants_quote ? "árajánlat" : "",
        quote.wants_consultation ? "személyes egyeztetés" : "",
      ].filter(Boolean).join(", ") || "nincs külön megjelölve"}`,
    );
  } else {
    const { data: cutting, error: cuttingError } = await client.from("cutting_quote_requests")
      .select("flow,material_source,fulfillment,material_hint,help_description,total_rows,total_pieces")
      .eq("quote_request_id", quote.id).eq("submission_state", "ready").maybeSingle();
    if (cuttingError || !cutting) throw cuttingError || new Error("cutting-details-missing");
    lines.push(
      `Lapszabászati mód: ${cutting.flow}`,
      `Anyag: ${cutting.material_hint || cutting.material_source || "nincs megadva"}`,
      `Átvétel: ${cutting.fulfillment}`,
      `Tételek: ${cutting.total_rows} sor, ${cutting.total_pieces} darab`,
      `Segítségkérés: ${cutting.help_description || "nincs"}`,
    );
    if (cutting.flow === "manual") {
      const { data: items, error: itemError } = await client.from("cutting_quote_items")
        .select("label,length_mm,width_mm,quantity,edge_code,edge_code_2,note")
        .eq("quote_request_id", quote.id).order("position").limit(200);
      if (itemError) throw itemError;
      for (const item of items || []) {
        lines.push(`${item.label || "Tétel"}: ${item.length_mm} × ${item.width_mm} mm, ${item.quantity} db, él: ${item.edge_code}${item.edge_code_2 ? ` / ${item.edge_code_2}` : ""}${item.note ? `, ${item.note}` : ""}`);
      }
      if ((cutting.total_rows || 0) > (items?.length || 0)) lines.push("A teljes lista az ügyfélkezelőben olvasható.");
    }
  }

  return lines.join("\n").slice(0, 20_000);
}

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") return json({ ok: false, code: "method-not-allowed" }, 405);
  const authHeader = request.headers.get("authorization");
  const url = Deno.env.get("SUPABASE_URL");
  const publicKey = keyFromEnv("SUPABASE_PUBLISHABLE_KEYS", "SUPABASE_ANON_KEY");
  const serviceKey = keyFromEnv("SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY");
  if (!authHeader?.startsWith("Bearer ") || !url || !publicKey) {
    return json({ ok: false, code: "unauthorized" }, 401);
  }

  const userClient = createClient(url, publicKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const token = authHeader.slice("Bearer ".length);
  const [{ data: userData, error: userError }, { data: claimsData, error: claimsError }] =
    await Promise.all([userClient.auth.getUser(token), userClient.auth.getClaims(token)]);
  if (userError || !userData.user || claimsError || claimsData?.claims?.sub !== userData.user.id) {
    return json({ ok: false, code: "unauthorized" }, 401);
  }
  if (claimsData.claims.aal !== "aal2") return json({ ok: false, code: "insufficient-aal" }, 403);
  const { data: admin, error: adminError } = await userClient.from("admin_users")
    .select("user_id").eq("user_id", userData.user.id).maybeSingle();
  if (adminError || !admin) return json({ ok: false, code: "forbidden" }, 403);

  const payload = await request.json().catch(() => null);
  const quoteId = payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>).quote_id : null;
  if (!Number.isSafeInteger(quoteId) || (quoteId as number) < 1) {
    return json({ ok: false, code: "invalid-quote-id" }, 400);
  }

  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!serviceKey || !apiKey) return json({ ok: false, code: "email-service-unavailable" }, 503);
  const serviceClient = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Load current data before taking the claim. Read failures cannot strand an outbox row.
  const { data, error: lookupError } = await userClient.from("quote_requests")
    .select("id,request_kind,source,intake_state,notification_error,notification_sent_at,customer_name,email,phone,message,project_type,approximate_dimensions,wants_callback,wants_quote,wants_consultation")
    .eq("id", quoteId as number).maybeSingle();
  if (lookupError || !data) return json({ ok: false, code: "not-found" }, 404);
  const quote = data as Quote;
  if (quote.source !== "website" || quote.intake_state !== "ready" ||
      quote.notification_error !== "resend-api-key-missing" || quote.notification_sent_at ||
      !["cutting", "furniture"].includes(quote.request_kind)) {
    return json({ ok: false, code: "not-eligible" }, 409);
  }

  let body: string;
  try {
    body = await notificationBody(userClient, quote);
  } catch (error) {
    console.error("intake notification content failed", error instanceof Error ? error.name : "unknown");
    return json({ ok: false, code: "content-unavailable" }, 503);
  }

  const { data: claim, error: claimError } = await serviceClient.rpc(
    "claim_admin_intake_notification_retry", { p_quote_id: quote.id },
  );
  if (claimError) {
    console.error("intake notification claim failed", claimError.code);
    return json({ ok: false, code: "claim-failed" }, 503);
  }
  if (claim?.state !== "send" || claim?.kind !== quote.request_kind) {
    return json({ ok: false, code: "not-eligible" }, 409);
  }

  let sent = false;
  let messageId: string | null = null;
  let failure = "notification-result-uncertain";
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        "idempotency-key": `hepa-${quote.request_kind}-new-${quote.id}`,
      },
      body: JSON.stringify({
        from: Deno.env.get("QUOTE_NOTIFICATION_FROM") || "HEPA ajánlatkérő <onboarding@resend.dev>",
        to: recipients(quote.request_kind),
        subject: `Pótolt értesítés: ${quote.request_kind === "cutting" ? "lapszabászati" : "bútorgyártási"} ajánlatkérés – ${reference(quote)}`,
        text: body,
        ...(quote.email ? { reply_to: quote.email } : {}),
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) failure = `resend-http-${response.status}`;
    else {
      const result = await response.json().catch(() => null);
      if (typeof result?.id === "string" && result.id) {
        sent = true;
        messageId = result.id;
      } else failure = "resend-response-missing-id";
    }
  } catch (error) {
    failure = error instanceof DOMException && error.name === "TimeoutError"
      ? "resend-timeout" : "resend-request-failed";
  }

  const { data: completed, error: completionError } = quote.request_kind === "cutting"
    ? await serviceClient.rpc("complete_cutting_quote_notification", {
      p_quote_request_id: quote.id,
      p_sent: sent,
      p_provider_message_id: messageId,
      p_error: sent ? null : failure,
    })
    : await serviceClient.rpc("complete_admin_furniture_notification_retry", {
      p_quote_id: quote.id,
      p_sent: sent,
      p_provider_message_id: messageId,
      p_error: sent ? null : failure,
    });

  const expectedState = quote.request_kind === "cutting"
    ? (sent ? "sent" : "retryable_error") : "recorded";
  if (completionError || !completed || completed.state !== expectedState) {
    console.error("intake notification completion unconfirmed", completionError?.code);
    return json({ ok: false, code: "delivery-uncertain" }, 503);
  }
  return sent
    ? json({ ok: true, state: "sent" }, 200)
    : json({ ok: false, code: "delivery-needs-review" }, 502);
});
