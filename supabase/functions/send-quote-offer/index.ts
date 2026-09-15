import { createClient } from "npm:@supabase/supabase-js@2.115.0";

const projectTypeLabels: Record<string, string> = {
  kitchen: "Konyhabútor",
  wardrobe: "Gardrób",
  entryway: "Előszobabútor",
  bathroom: "Fürdőszobabútor",
  living_room: "Nappali bútor",
  office: "Irodabútor",
  custom: "Egyedi bútor",
  other: "Egyéb",
  cutting: "Lapszabászat és ABS élzárás",
};

const moneyFormatter = new Intl.NumberFormat("hu-HU", {
  style: "currency",
  currency: "HUF",
  maximumFractionDigits: 0,
});

type UnknownRecord = Record<string, unknown>;

type OfferSnapshot = {
  id: number;
  offer_number: string;
  version: number;
  kind: string;
  vat_rate: unknown;
  net_total: unknown;
  vat_total: unknown;
  gross_total: unknown;
  deposit_percent: unknown;
  deposit_amount: unknown;
  valid_until: string | null;
  lead_time: string | null;
  customer_note: string | null;
};

type CustomerSnapshot = {
  customer_name: string;
  email: string;
  project_type: string;
};

type OfferItemSnapshot = {
  position: number;
  description: string;
  quantity: unknown;
  unit: string;
  unit_net_price: unknown;
  line_net_total: unknown;
};

type DeliverySnapshot = {
  offer: OfferSnapshot;
  customer: CustomerSnapshot;
  items: OfferItemSnapshot[];
};

type ProviderPayload = {
  from: string;
  to: string[];
  reply_to: string;
  subject: string;
  html: string;
  text: string;
};

type DeliveryRpcResult = {
  state?: string;
  authorization_id?: string;
  delivery_id?: string;
  offer_id?: number;
  recipient_email?: string;
  content_snapshot?: unknown;
  provider_payload?: string;
  payload_sha256?: string;
  idempotency_key?: string;
  provider_message_id?: string;
  lease_token?: string;
  lease_expires_at?: string;
  last_error_code?: string;
};

type RpcError = {
  code?: string;
  message?: string;
};

function json(body: Record<string, unknown>, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function publishableKey() {
  const modernKeys = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
  if (modernKeys) {
    try {
      const parsed = JSON.parse(modernKeys) as Record<string, string>;
      if (parsed.default) return parsed.default;
    } catch {
      console.error("SUPABASE_PUBLISHABLE_KEYS is not valid JSON");
    }
  }

  return Deno.env.get("SUPABASE_ANON_KEY");
}

function emailDeliveryEnabled() {
  return Deno.env.get("QUOTE_OFFER_EMAIL_ENABLED")?.trim().toLowerCase() === "true";
}

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseDeliverySnapshot(value: unknown): DeliverySnapshot | null {
  const root = asRecord(value);
  const offer = asRecord(root?.offer);
  const customer = asRecord(root?.customer);
  const rawItems = root?.items;
  const offerId = finiteNumber(offer?.id);
  const version = finiteNumber(offer?.version);
  const offerNumber = nonEmptyString(offer?.offer_number);
  const kind = nonEmptyString(offer?.kind);
  const customerName = nonEmptyString(customer?.customer_name);
  const customerEmail = nonEmptyString(customer?.email);
  const projectType = nonEmptyString(customer?.project_type);

  if (
    !offer || !customer || !Array.isArray(rawItems) || rawItems.length < 1 ||
    offerId === null || !Number.isSafeInteger(offerId) ||
    version === null || !Number.isSafeInteger(version) ||
    !offerNumber || !kind || !customerName || !customerEmail || !projectType
  ) {
    return null;
  }

  const items: OfferItemSnapshot[] = [];
  for (const rawItem of rawItems) {
    const item = asRecord(rawItem);
    const position = finiteNumber(item?.position);
    const description = nonEmptyString(item?.description);
    const unit = nonEmptyString(item?.unit);
    if (
      !item || position === null || !Number.isSafeInteger(position) ||
      !description || !unit
    ) {
      return null;
    }
    items.push({
      position,
      description,
      quantity: item.quantity,
      unit,
      unit_net_price: item.unit_net_price,
      line_net_total: item.line_net_total,
    });
  }

  return {
    offer: {
      id: offerId,
      offer_number: offerNumber,
      version,
      kind,
      vat_rate: offer.vat_rate,
      net_total: offer.net_total,
      vat_total: offer.vat_total,
      gross_total: offer.gross_total,
      deposit_percent: offer.deposit_percent,
      deposit_amount: offer.deposit_amount,
      valid_until: nullableString(offer.valid_until),
      lead_time: nullableString(offer.lead_time),
      customer_note: nullableString(offer.customer_note),
    },
    customer: {
      customer_name: customerName,
      email: customerEmail,
      project_type: projectType,
    },
    items,
  };
}

function parseProviderPayload(value: unknown): ProviderPayload | null {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }

  const payload = asRecord(parsed);
  if (!payload || !Array.isArray(payload.to) || payload.to.length !== 1) {
    return null;
  }

  const from = nonEmptyString(payload.from);
  const to = nonEmptyString(payload.to[0]);
  const replyTo = nonEmptyString(payload.reply_to);
  const subject = nonEmptyString(payload.subject);
  const html = nonEmptyString(payload.html);
  const text = nonEmptyString(payload.text);

  if (!from || !to || !replyTo || !subject || !html || !text) return null;
  return { from, to: [to], reply_to: replyTo, subject, html, text };
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatMoney(value: unknown) {
  const amount = Number(value);
  return moneyFormatter.format(Number.isFinite(amount) ? amount : 0);
}

function formatDate(value: string | null) {
  if (!value) return "Nincs megadva";
  const date = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return "Nincs megadva";
  return new Intl.DateTimeFormat("hu-HU", {
    dateStyle: "long",
    timeZone: "Europe/Budapest",
  }).format(date);
}

function offerEmail(snapshot: DeliverySnapshot) {
  const { customer, offer } = snapshot;
  const items = snapshot.items.slice().sort((a, b) => a.position - b.position);
  const kindLabel = offer.kind === "final" ? "Végleges árajánlat" : "Előzetes árajánlat";
  const projectLabel = projectTypeLabels[customer.project_type] ?? customer.project_type;

  const itemRows = items.map((item) => `
    <tr>
      <td style="padding:12px 8px;border-bottom:1px solid #dbe7e1;color:#10251e;font-weight:700">${escapeHtml(item.description)}</td>
      <td style="padding:12px 8px;border-bottom:1px solid #dbe7e1;color:#466156">${escapeHtml(item.quantity)} ${escapeHtml(item.unit)}</td>
      <td style="padding:12px 8px;border-bottom:1px solid #dbe7e1;color:#466156;text-align:right">${escapeHtml(formatMoney(item.unit_net_price))}</td>
      <td style="padding:12px 8px;border-bottom:1px solid #dbe7e1;color:#10251e;font-weight:800;text-align:right">${escapeHtml(formatMoney(item.line_net_total))}</td>
    </tr>`).join("");

  const html = `<!doctype html>
  <html lang="hu">
    <body style="margin:0;padding:0;background:#edf4f0;font-family:Arial,sans-serif;color:#10251e">
      <div style="max-width:760px;margin:0 auto;padding:30px 16px">
        <div style="background:#f9fcfa;border:1px solid #d4e2db;border-radius:20px;overflow:hidden">
          <div style="padding:28px 32px;background:#092019;color:#f4fbf7">
            <div style="font-weight:900;letter-spacing:.08em">HEPA <span style="color:#d39a34">BÚTORGYÁRTÁS</span></div>
            <div style="margin-top:28px;color:#3ecf8e;font-size:12px;font-weight:800;letter-spacing:.12em">${escapeHtml(kindLabel.toUpperCase())}</div>
            <h1 style="margin:8px 0 0;font-size:42px;line-height:1">Árajánlat</h1>
            <p style="margin:12px 0 0;color:#a9beb5">${escapeHtml(offer.offer_number)} · ${escapeHtml(offer.version)}. változat</p>
          </div>
          <div style="padding:30px 32px">
            <p style="margin:0 0 8px;color:#62786f;font-size:13px">Tisztelt ${escapeHtml(customer.customer_name)}!</p>
            <p style="margin:0 0 28px;line-height:1.6">Köszönjük megkeresését. Az alábbi árajánlatot készítettük a(z) ${escapeHtml(projectLabel)} projektre.</p>
            <table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px">
              <thead>
                <tr style="color:#62786f;font-size:11px;text-transform:uppercase">
                  <th style="padding:10px 8px;text-align:left">Megnevezés</th>
                  <th style="padding:10px 8px;text-align:left">Mennyiség</th>
                  <th style="padding:10px 8px;text-align:right">Nettó egységár</th>
                  <th style="padding:10px 8px;text-align:right">Nettó összeg</th>
                </tr>
              </thead>
              <tbody>${itemRows}</tbody>
            </table>
            <div style="width:100%;max-width:380px;margin:24px 0 0 auto">
              <p style="display:flex;justify-content:space-between;gap:20px;margin:0;padding:10px 0;border-bottom:1px solid #dbe7e1"><span style="color:#62786f">Nettó összesen</span><strong>${escapeHtml(formatMoney(offer.net_total))}</strong></p>
              <p style="display:flex;justify-content:space-between;gap:20px;margin:0;padding:10px 0;border-bottom:1px solid #dbe7e1"><span style="color:#62786f">ÁFA (${escapeHtml(offer.vat_rate)}%)</span><strong>${escapeHtml(formatMoney(offer.vat_total))}</strong></p>
              <p style="display:flex;justify-content:space-between;gap:20px;margin:0;padding:14px 0;border-bottom:1px solid #dbe7e1;color:#16855c;font-size:18px"><span>Bruttó végösszeg</span><strong>${escapeHtml(formatMoney(offer.gross_total))}</strong></p>
              ${Number(offer.deposit_percent) > 0 ? `<p style="display:flex;justify-content:space-between;gap:20px;margin:0;padding:10px 0"><span style="color:#62786f">Előleg (${escapeHtml(offer.deposit_percent)}%)</span><strong>${escapeHtml(formatMoney(offer.deposit_amount))}</strong></p>` : ""}
            </div>
            <div style="margin-top:28px;padding-top:22px;border-top:1px solid #dbe7e1">
              <p style="margin:8px 0"><strong>Ajánlat érvényessége:</strong> ${escapeHtml(formatDate(offer.valid_until))}</p>
              <p style="margin:8px 0"><strong>Várható gyártási idő:</strong> ${escapeHtml(offer.lead_time || "Nincs megadva")}</p>
            </div>
            ${offer.customer_note ? `<p style="margin:24px 0 0;padding:16px 18px;border-left:4px solid #3ecf8e;background:#edf7f1;line-height:1.6;white-space:pre-wrap">${escapeHtml(offer.customer_note)}</p>` : ""}
            <p style="margin:30px 0 0;color:#62786f;font-size:13px;line-height:1.6">Az ajánlattal kapcsolatban válaszoljon erre az e-mailre. Köszönjük a bizalmát!</p>
          </div>
        </div>
      </div>
    </body>
  </html>`;

  const itemText = items.map((item) =>
    `- ${item.description}: ${item.quantity} ${item.unit} × ${formatMoney(item.unit_net_price)} = ${formatMoney(item.line_net_total)} nettó`
  ).join("\n");
  const text = [
    `Tisztelt ${customer.customer_name}!`,
    "",
    `Azonosító: ${offer.offer_number} (${offer.version}. változat)`,
    `Projekt: ${projectLabel}`,
    "",
    itemText,
    "",
    `Nettó összesen: ${formatMoney(offer.net_total)}`,
    `ÁFA (${offer.vat_rate}%): ${formatMoney(offer.vat_total)}`,
    `Bruttó végösszeg: ${formatMoney(offer.gross_total)}`,
    ...(Number(offer.deposit_percent) > 0
      ? [`Előleg (${offer.deposit_percent}%): ${formatMoney(offer.deposit_amount)}`]
      : []),
    `Érvényes: ${formatDate(offer.valid_until)}`,
    `Várható gyártási idő: ${offer.lead_time || "Nincs megadva"}`,
    ...(offer.customer_note ? ["", offer.customer_note] : []),
    "",
    "Köszönjük a megkeresést! Az ajánlattal kapcsolatban válaszoljon erre az e-mailre.",
  ].join("\n");

  return { html, kindLabel, text };
}

function deliveryStateResponse(result: DeliveryRpcResult) {
  switch (result.state) {
    case "already_sent":
    case "finalized":
      return json({ ok: true, already_sent: true }, 200);
    case "send_in_progress":
      return json({ ok: false, code: "send-in-progress" }, 409);
    case "expired":
      return json({ ok: false, code: "offer-expired" }, 409);
    case "needs_review":
      return json({
        ok: false,
        code: "delivery-needs-review",
        reason: result.last_error_code ?? "unknown",
      }, 409);
    case "payload_required":
      return json({ ok: false, code: "delivery-payload-required" }, 409);
    default:
      return null;
  }
}

function rpcErrorResponse(error: RpcError | null, fallbackCode: string) {
  const message = error?.message ?? "";
  if (message.includes("aal2-required")) {
    return json({ ok: false, code: "insufficient-aal" }, 403);
  }
  if (
    message.includes("token-expired") ||
    message.includes("authorization-expired")
  ) {
    return json({ ok: false, code: "authorization-expired" }, 401);
  }
  if (message.includes("admin-required") || message.includes("unauthorized")) {
    return json({ ok: false, code: "forbidden" }, 403);
  }
  if (message.includes("service-role-required")) {
    return json({ ok: false, code: "email-service-unavailable" }, 503);
  }
  if (message.includes("offer-not-found") || message.includes("delivery-not-found")) {
    return json({ ok: false, code: "offer-not-found" }, 404);
  }
  if (message.includes("offer-requires-resave")) {
    return json({ ok: false, code: "offer-requires-resave" }, 422);
  }
  if (message.includes("offer-snapshot-stale")) {
    return json({ ok: false, code: "offer-snapshot-stale" }, 409);
  }
  if (
    message.includes("offer-snapshot-invalid") ||
    message.includes("offer-not-sendable") ||
    message.includes("offer-items-invalid") ||
    message.includes("delivery-payload-invalid") ||
    message.includes("delivery-recipient-mismatch")
  ) {
    return json({ ok: false, code: "offer-not-sendable" }, 422);
  }
  if (message.includes("offer-expired")) {
    return json({ ok: false, code: "offer-expired" }, 409);
  }
  if (
    message.includes("offer-not-draft") ||
    message.includes("quote-request-locked") ||
    message.includes("finalization-conflict") ||
    message.includes("delivery-authorization-stale") ||
    message.includes("offer-delivery-already-prepared")
  ) {
    return json({ ok: false, code: "offer-state-conflict" }, 409);
  }
  if (message.includes("delivery-reset-unsafe")) {
    return json({ ok: false, code: "delivery-reset-unsafe" }, 409);
  }

  console.error("quote delivery RPC failed", error?.code ?? "unknown");
  return json({ ok: false, code: fallbackCode }, 500);
}

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") {
    return json({ ok: false, code: "method-not-allowed" }, 405);
  }

  const authorizationHeader = request.headers.get("authorization");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const apiKey = publishableKey();

  if (!authorizationHeader?.startsWith("Bearer ") || !supabaseUrl || !apiKey) {
    return json({ ok: false, code: "unauthorized" }, 401);
  }

  const supabase = createClient(supabaseUrl, apiKey, {
    global: { headers: { Authorization: authorizationHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const token = authorizationHeader.slice("Bearer ".length);
  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims(token);
  const userId = claimsData?.claims?.sub;

  if (claimsError || !userId) {
    return json({ ok: false, code: "unauthorized" }, 401);
  }

  if (claimsData.claims.aal !== "aal2") {
    return json({ ok: false, code: "insufficient-aal" }, 403);
  }

  const { data: admin, error: adminError } = await supabase
    .from("admin_users")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();

  if (adminError) {
    console.error("admin authorization lookup failed", adminError.code);
    return json({ ok: false, code: "authorization-check-failed" }, 500);
  }
  if (!admin) return json({ ok: false, code: "forbidden" }, 403);

  let requestPayload: UnknownRecord;
  try {
    const parsed = await request.json();
    const record = asRecord(parsed);
    if (!record) return json({ ok: false, code: "invalid-json" }, 400);
    requestPayload = record;
  } catch {
    return json({ ok: false, code: "invalid-json" }, 400);
  }

  const action = requestPayload.action ?? "send";
  if (action !== "send" && action !== "reset") {
    return json({ ok: false, code: "invalid-action" }, 400);
  }

  const rawOfferId = requestPayload.offer_id;
  const offerId = typeof rawOfferId === "number"
    ? rawOfferId
    : typeof rawOfferId === "string" && /^[1-9][0-9]*$/.test(rawOfferId)
    ? Number(rawOfferId)
    : Number.NaN;
  if (!Number.isSafeInteger(offerId) || offerId < 1) {
    return json({ ok: false, code: "invalid-offer" }, 400);
  }

  // This independent flag fails closed. Missing, malformed and false values
  // all keep provider calls disabled, regardless of the web application's UI.
  if (action === "send" && !emailDeliveryEnabled()) {
    return json({ ok: false, code: "email-delivery-disabled" }, 503);
  }

  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!serviceRoleKey) {
    return json({ ok: false, code: "email-service-unavailable" }, 503);
  }

  const serviceSupabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: authorizationData, error: authorizationError } = await supabase.rpc(
    "authorize_quote_offer_delivery",
    { p_offer_id: offerId },
  );
  if (authorizationError || !authorizationData) {
    return rpcErrorResponse(authorizationError, "delivery-authorization-failed");
  }

  const deliveryAuthorization = authorizationData as DeliveryRpcResult;
  const authorizationId = nonEmptyString(deliveryAuthorization.authorization_id);
  if (deliveryAuthorization.state !== "authorized" || !authorizationId) {
    console.error("delivery authorization returned invalid data");
    return json({ ok: false, code: "delivery-authorization-failed" }, 500);
  }

  if (action === "reset") {
    const { data: resetData, error: resetError } = await serviceSupabase.rpc(
      "reset_quote_offer_delivery",
      { p_authorization_id: authorizationId },
    );
    if (resetError || !resetData) {
      return rpcErrorResponse(resetError, "delivery-reset-failed");
    }

    const reset = resetData as DeliveryRpcResult;
    const terminalResponse = deliveryStateResponse(reset);
    if (terminalResponse) return terminalResponse;
    if (reset.state !== "reset" && reset.state !== "no_delivery") {
      console.error("delivery reset returned an unknown state");
      return json({ ok: false, code: "delivery-reset-failed" }, 500);
    }

    return json({ ok: true, state: reset.state, delivery_id: reset.delivery_id }, 200);
  }

  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("QUOTE_OFFER_FROM")?.trim();
  const replyTo = (Deno.env.get("QUOTE_OFFER_REPLY_TO") || "hepaconstructkft@gmail.com").trim();

  if (!resendApiKey) return json({ ok: false, code: "email-service-unavailable" }, 503);
  if (!from) return json({ ok: false, code: "sender-domain-required" }, 503);

  const { data: prepareData, error: prepareError } = await serviceSupabase.rpc(
    "prepare_quote_offer_delivery",
    { p_authorization_id: authorizationId },
  );

  if (prepareError || !prepareData) {
    return rpcErrorResponse(prepareError, "delivery-prepare-failed");
  }

  let prepared = prepareData as DeliveryRpcResult;
  const preparedTerminalResponse = deliveryStateResponse(prepared);
  if (preparedTerminalResponse) return preparedTerminalResponse;

  const deliveryId = nonEmptyString(prepared.delivery_id);
  if (!deliveryId) {
    console.error("delivery prepare returned no delivery id");
    return json({ ok: false, code: "delivery-prepare-failed" }, 500);
  }

  if (!nonEmptyString(prepared.provider_payload)) {
    const snapshot = parseDeliverySnapshot(prepared.content_snapshot);
    const recipientEmail = nonEmptyString(prepared.recipient_email);
    if (!snapshot || !recipientEmail) {
      console.error("delivery prepare returned an invalid snapshot");
      return json({ ok: false, code: "delivery-snapshot-invalid" }, 500);
    }

    const content = offerEmail(snapshot);
    const providerPayload: ProviderPayload = {
      from,
      to: [recipientEmail],
      reply_to: replyTo,
      subject: `${content.kindLabel} – ${snapshot.offer.offer_number}`,
      html: content.html,
      text: content.text,
    };
    const providerPayloadText = JSON.stringify(providerPayload);

    const { data: freezeData, error: freezeError } = await serviceSupabase.rpc(
      "freeze_quote_offer_delivery_payload",
      {
        p_delivery_id: deliveryId,
        p_provider_payload: providerPayloadText,
      },
    );

    if (freezeError || !freezeData) {
      return rpcErrorResponse(freezeError, "delivery-payload-freeze-failed");
    }

    prepared = freezeData as DeliveryRpcResult;
    const frozenTerminalResponse = deliveryStateResponse(prepared);
    if (frozenTerminalResponse) return frozenTerminalResponse;
  }

  const { data: claimData, error: claimError } = await serviceSupabase.rpc(
    "claim_quote_offer_delivery",
    { p_delivery_id: deliveryId },
  );

  if (claimError || !claimData) {
    return rpcErrorResponse(claimError, "delivery-claim-failed");
  }

  const claim = claimData as DeliveryRpcResult;
  const claimTerminalResponse = deliveryStateResponse(claim);
  if (claimTerminalResponse) return claimTerminalResponse;

  if (claim.state !== "claimed") {
    console.error("delivery claim returned an unknown state");
    return json({ ok: false, code: "delivery-claim-failed" }, 500);
  }

  const providerPayloadText = nonEmptyString(claim.provider_payload);
  const providerPayload = parseProviderPayload(providerPayloadText);
  const idempotencyKey = nonEmptyString(claim.idempotency_key);
  const leaseToken = nonEmptyString(claim.lease_token);
  if (
    !providerPayloadText || !providerPayload ||
    !idempotencyKey || idempotencyKey.length > 256 ||
    !leaseToken
  ) {
    console.error("delivery claim returned invalid provider metadata");
    return json({ ok: false, code: "delivery-claim-invalid" }, 500);
  }

  const recordError = async (
    errorCode: string,
    httpStatus: number | null,
    needsReview: boolean,
    holdLease: boolean,
    ambiguousAttempt: boolean,
    acceptedProviderMessageId: string | null = null,
  ) => {
    const { error } = await serviceSupabase.rpc("record_quote_offer_delivery_error", {
      p_delivery_id: deliveryId,
      p_lease_token: leaseToken,
      p_error_code: errorCode.slice(0, 100),
      p_http_status: httpStatus,
      p_needs_review: needsReview,
      p_hold_lease: holdLease,
      p_ambiguous_attempt: ambiguousAttempt,
      p_provider_message_id: acceptedProviderMessageId,
    });
    if (error) console.error("delivery error state update failed", error.code);
  };

  let resendResponse: Response;
  try {
    resendResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "authorization": `Bearer ${resendApiKey}`,
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: providerPayloadText,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    const errorName = error instanceof Error ? error.name : "unknown";
    console.error("resend request failed", errorName);
    await recordError(
      `network-${errorName.toLowerCase()}`,
      null,
      false,
      true,
      true,
    );
    return json({
      ok: false,
      code: "email-request-failed",
      delivery_uncertain: true,
    }, 502);
  }

  const rawResendBody = await resendResponse.json().catch(() => ({}));
  const resendBody = asRecord(rawResendBody) ?? {};
  const providerMessageId = nonEmptyString(resendBody.id);
  const providerErrorName = nonEmptyString(resendBody.name) ?? "provider-rejected";

  if (!resendResponse.ok) {
    if (providerErrorName === "invalid_idempotent_request") {
      await recordError(providerErrorName, resendResponse.status, true, false, true);
      return json({ ok: false, code: "delivery-needs-review" }, 409);
    }

    if (providerErrorName === "concurrent_idempotent_requests") {
      await recordError(providerErrorName, resendResponse.status, false, true, true);
      return json({ ok: false, code: "send-in-progress" }, 409);
    }

    const configurationError = resendResponse.status === 401 || resendResponse.status === 403;
    const ambiguous = resendResponse.status >= 500 ||
      resendResponse.status === 408 || resendResponse.status === 425;
    const permanentClientError = resendResponse.status >= 400 &&
      resendResponse.status < 500 &&
      !configurationError &&
      !ambiguous &&
      resendResponse.status !== 429;
    await recordError(
      providerErrorName,
      resendResponse.status,
      permanentClientError,
      ambiguous,
      ambiguous,
    );

    if (resendResponse.status === 401) {
      return json({ ok: false, code: "email-service-unavailable" }, 503);
    }
    if (resendResponse.status === 403) {
      return json({ ok: false, code: "sender-domain-required" }, 503);
    }
    if (resendResponse.status === 429) {
      return json({ ok: false, code: "email-rate-limited" }, 503);
    }
    if (permanentClientError) {
      return json({
        ok: false,
        code: "delivery-needs-review",
        reason: providerErrorName,
      }, 409);
    }

    return json({
      ok: false,
      code: ambiguous ? "email-request-failed" : "email-rejected",
      ...(ambiguous ? { delivery_uncertain: true } : {}),
    }, 502);
  }

  if (!providerMessageId) {
    console.error("resend accepted request without a message id");
    await recordError(
      "provider-response-missing-id",
      resendResponse.status,
      true,
      false,
      true,
    );
    return json({
      ok: false,
      code: "delivery-needs-review",
      delivery_uncertain: true,
    }, 502);
  }

  const { data: finalizeData, error: finalizeError } = await serviceSupabase.rpc(
    "finalize_quote_offer_delivery",
    {
      p_delivery_id: deliveryId,
      p_lease_token: leaseToken,
      p_provider_message_id: providerMessageId,
      p_http_status: resendResponse.status,
    },
  );

  if (finalizeError || (finalizeData as DeliveryRpcResult | null)?.state !== "finalized") {
    console.error("offer delivery finalization failed", finalizeError?.code ?? "unknown");
    // If finalization did not commit, persist that the provider already
    // accepted the message.  If it did commit but the response was lost, the
    // idempotent recorder simply observes the finalized terminal state.
    await recordError(
      "provider-accepted-finalize-failed",
      resendResponse.status,
      true,
      false,
      true,
      providerMessageId,
    );
    return json({
      ok: false,
      code: "sent-state-update-failed",
      email_sent: true,
      delivery_id: deliveryId,
    }, 500);
  }

  return json({ ok: true, delivery_id: deliveryId }, 200);
});

