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
};

const moneyFormatter = new Intl.NumberFormat("hu-HU", {
  style: "currency",
  currency: "HUF",
  maximumFractionDigits: 0,
});

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
  return new Intl.DateTimeFormat("hu-HU", {
    dateStyle: "long",
    timeZone: "Europe/Budapest",
  }).format(new Date(`${value}T12:00:00Z`));
}

function offerEmail(offer: Record<string, any>) {
  const request = offer.quote_requests as Record<string, any>;
  const items = (offer.quote_offer_items as Array<Record<string, any>>)
    .slice()
    .sort((a, b) => Number(a.position) - Number(b.position));
  const kindLabel = offer.kind === "final" ? "Végleges árajánlat" : "Előzetes árajánlat";
  const projectLabel = projectTypeLabels[request.project_type] ?? request.project_type ?? "Egyedi bútor";

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
            <p style="margin:0 0 8px;color:#62786f;font-size:13px">Tisztelt ${escapeHtml(request.customer_name)}!</p>
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
    `Tisztelt ${request.customer_name}!`,
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

  return { html, kindLabel, request, text };
}

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") {
    return json({ ok: false, code: "method-not-allowed" }, 405);
  }

  const authorization = request.headers.get("authorization");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const apiKey = publishableKey();

  if (!authorization?.startsWith("Bearer ") || !supabaseUrl || !apiKey) {
    return json({ ok: false, code: "unauthorized" }, 401);
  }

  const supabase = createClient(supabaseUrl, apiKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const token = authorization.slice("Bearer ".length);
  const { data: userData, error: userError } = await supabase.auth.getUser(token);

  if (userError || !userData.user) {
    return json({ ok: false, code: "unauthorized" }, 401);
  }

  const { data: admin } = await supabase
    .from("admin_users")
    .select("user_id")
    .eq("user_id", userData.user.id)
    .maybeSingle();

  if (!admin) return json({ ok: false, code: "forbidden" }, 403);

  let payload: { offer_id?: unknown };
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, code: "invalid-json" }, 400);
  }

  const offerId = Number(payload.offer_id);
  if (!Number.isSafeInteger(offerId) || offerId < 1) {
    return json({ ok: false, code: "invalid-offer" }, 400);
  }

  const { data: offer, error: offerError } = await supabase
    .from("quote_offers")
    .select(`
      id, offer_number, version, kind, status, vat_rate,
      net_total, vat_total, gross_total, deposit_percent, deposit_amount,
      valid_until, lead_time, customer_note, updated_at,
      quote_offer_items(position, description, quantity, unit, unit_net_price, line_net_total),
      quote_requests!inner(id, customer_name, email, phone, project_type, status)
    `)
    .eq("id", offerId)
    .maybeSingle();

  if (offerError || !offer) {
    console.error("offer lookup failed", offerError?.code);
    return json({ ok: false, code: "offer-not-found" }, 404);
  }

  if (offer.status === "sent") {
    return json({ ok: true, already_sent: true }, 200);
  }

  if (offer.status !== "draft") {
    return json({ ok: false, code: "offer-not-draft" }, 409);
  }

  if (["ordered", "closed"].includes(offer.quote_requests.status)) {
    return json({ ok: false, code: "quote-request-locked" }, 409);
  }

  const email = offer.quote_requests.email?.trim().toLowerCase();
  if (!email || Number(offer.gross_total) <= 0 || !offer.lead_time) {
    return json({ ok: false, code: "offer-not-sendable" }, 422);
  }

  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("QUOTE_OFFER_FROM");
  const replyTo = Deno.env.get("QUOTE_OFFER_REPLY_TO") || "hepaconstructkft@gmail.com";

  if (!resendApiKey) return json({ ok: false, code: "email-service-unavailable" }, 503);
  if (!from) return json({ ok: false, code: "sender-domain-required" }, 503);

  const content = offerEmail(offer);
  const idempotencyKey = `quote-offer/${offer.id}/${offer.updated_at}`.slice(0, 256);

  let resendResponse: Response;
  try {
    resendResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "authorization": `Bearer ${resendApiKey}`,
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({
        from,
        to: [email],
        reply_to: replyTo,
        subject: `${content.kindLabel} – ${offer.offer_number}`,
        html: content.html,
        text: content.text,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    console.error("resend request failed", error instanceof Error ? error.name : "unknown");
    return json({ ok: false, code: "email-request-failed" }, 502);
  }

  const resendBody = await resendResponse.json().catch(() => ({})) as { id?: string };
  if (!resendResponse.ok || !resendBody.id) {
    console.error("resend rejected offer email", resendResponse.status);
    return json({
      ok: false,
      code: resendResponse.status === 403 ? "sender-domain-required" : "email-rejected",
    }, resendResponse.status === 403 ? 503 : 502);
  }

  const { error: markError } = await supabase.rpc("mark_quote_offer_sent", {
    p_offer_id: offer.id,
    p_sent_to: email,
    p_provider_message_id: resendBody.id,
  });

  if (markError) {
    console.error("mark offer sent failed", markError.code);
    return json({ ok: false, code: "sent-state-update-failed", email_sent: true }, 500);
  }

  return json({ ok: true }, 200);
});
