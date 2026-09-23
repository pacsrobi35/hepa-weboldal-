import { createClient } from "npm:@supabase/supabase-js@2.115.0";

const allowedOrigins = new Set([
  "https://hepa-ugyfelkezeles.vercel.app",
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:3002",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:3001",
  "http://127.0.0.1:3002",
]);

function isAllowedOrigin(origin: string) {
  return !origin || allowedOrigins.has(origin);
}

const manualSources = new Set([
  "email",
  "phone",
  "paper",
  "in_person",
  "other",
]);
const projectTypes = new Set([
  "kitchen",
  "wardrobe",
  "entryway",
  "bathroom",
  "living_room",
  "office",
  "custom",
  "other",
]);
const preferredContacts = new Set(["phone", "email"]);
const entryTypes = new Set(["quote_request", "direct_order"]);
const requestKinds = new Set(["furniture", "cutting"]);
const cuttingMaterialSources = new Set(["hepa", "own", "unknown"]);
const cuttingFulfillments = new Set(["pickup", "delivery", "unknown"]);
const nextActionKinds = new Set([
  "callback",
  "quote",
  "survey",
  "installation",
  "other",
]);
const filePurposes = new Set([
  "reference",
  "cutting_list",
  "help_attachment",
  "paper_order",
  "signed_offer",
  "contract",
  "survey_photo",
  "visualization",
  "workshop_drawing",
]);
const fileTypes: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

type ServiceClient = ReturnType<typeof createClient>;

function responseHeaders(origin: string) {
  const headers: Record<string, string> = {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  };

  if (origin && isAllowedOrigin(origin)) {
    headers["access-control-allow-origin"] = origin;
    headers.vary = "Origin";
  }

  return headers;
}

function json(body: Record<string, unknown>, status: number, origin: string) {
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders(origin),
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

function serviceRoleKey() {
  const modernKeys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (modernKeys) {
    try {
      const parsed = JSON.parse(modernKeys) as Record<string, string>;
      if (parsed.default) return parsed.default;
    } catch {
      console.error("SUPABASE_SECRET_KEYS is not valid JSON");
    }
  }

  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
}

function text(formData: FormData, name: string, maxLength: number) {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim().slice(0, maxLength + 1) : "";
}

function checked(formData: FormData, name: string) {
  return ["on", "true", "1"].includes(text(formData, name, 10).toLowerCase());
}

function optionalAmount(formData: FormData, name: string) {
  const raw = text(formData, name, 30).replace(/\s/g, "").replace(",", ".");
  if (!raw) return null;
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) return Number.NaN;
  return Number(raw);
}

function optionalDate(formData: FormData, name: string) {
  const value = text(formData, name, 10);
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return "invalid";

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year &&
      parsed.getUTCMonth() === month - 1 &&
      parsed.getUTCDate() === day
    ? value
    : "invalid";
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function startsWithBytes(bytes: Uint8Array, expected: number[], offset = 0) {
  return expected.every((value, index) => bytes[offset + index] === value);
}

async function hasValidFileSignature(file: File) {
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());

  switch (file.type) {
    case "image/jpeg":
      return startsWithBytes(bytes, [0xff, 0xd8, 0xff]);
    case "image/png":
      return startsWithBytes(
        bytes,
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      );
    case "image/webp":
      return startsWithBytes(bytes, [0x52, 0x49, 0x46, 0x46]) &&
        startsWithBytes(bytes, [0x57, 0x45, 0x42, 0x50], 8);
    case "application/pdf":
      return startsWithBytes(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]);
    default:
      return false;
  }
}

async function rollbackQuote(
  supabase: ServiceClient,
  quoteId: number,
  uploadedPaths: string[],
) {
  if (uploadedPaths.length) {
    const { error: storageError } = await supabase.storage
      .from("quote-request-files")
      .remove(uploadedPaths);
    if (storageError) {
      console.error("manual quote rollback storage failed", storageError.message);
    }
  }

  const { error: quoteError } = await supabase
    .from("quote_requests")
    .delete()
    .eq("id", quoteId);
  if (quoteError) {
    console.error("manual quote rollback row failed", quoteError.code);
  }
}

async function storeQuoteFiles(
  supabase: ServiceClient,
  userId: string,
  quoteId: number,
  files: File[],
  filePurpose: string,
) {
  const uploadedPaths: string[] = [];
  const fileRows: Array<Record<string, unknown>> = [];

  for (const file of files) {
    const extension = fileTypes[file.type];
    const storagePath =
      `manual/${userId}/${quoteId}/${crypto.randomUUID()}.${extension}`;
    const { error: uploadError } = await supabase.storage
      .from("quote-request-files")
      .upload(storagePath, file, {
        contentType: file.type,
        upsert: false,
      });

    if (uploadError) {
      console.error("manual quote file upload failed", uploadError.message);
      if (uploadedPaths.length) {
        await supabase.storage.from("quote-request-files").remove(uploadedPaths);
      }
      return { ok: false as const, message: "A fájl feltöltése nem sikerült." };
    }

    uploadedPaths.push(storagePath);
    fileRows.push({
      content_type: file.type,
      file_purpose: filePurpose,
      original_name: file.name.slice(0, 255) || `feltoltes.${extension}`,
      quote_request_id: quoteId,
      size_bytes: file.size,
      storage_path: storagePath,
    });
  }

  if (fileRows.length) {
    const { error: fileRowsError } = await supabase
      .from("quote_request_files")
      .insert(fileRows);

    if (fileRowsError) {
      console.error("manual quote file metadata insert failed", fileRowsError.code);
      await supabase.storage.from("quote-request-files").remove(uploadedPaths);
      return { ok: false as const, message: "A fájl adatainak mentése nem sikerült." };
    }
  }

  return { ok: true as const, uploadedPaths };
}

Deno.serve(async (request: Request) => {
  const origin = request.headers.get("origin") ?? "";

  if (origin && !isAllowedOrigin(origin)) {
    return json({ error: "Ez az oldal nem rögzíthet ajánlatkérést." }, 403, origin);
  }

  if (request.method === "OPTIONS") {
    if (!origin) return new Response(null, { status: 204 });
    return new Response(null, {
      status: 204,
      headers: {
        ...responseHeaders(origin),
        "access-control-allow-headers":
          "authorization, apikey, content-type, x-client-info",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-max-age": "86400",
      },
    });
  }

  if (request.method !== "POST") {
    return json({ error: "Nem támogatott kérés." }, 405, origin);
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > 55 * 1024 * 1024) {
    return json({ error: "A feltöltés összmérete túl nagy." }, 413, origin);
  }

  const authorization = request.headers.get("authorization");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const apiKey = publishableKey();
  const secretKey = serviceRoleKey();

  if (
    !authorization?.startsWith("Bearer ") ||
    !supabaseUrl ||
    !apiKey ||
    !secretKey
  ) {
    return json({ error: "Nincs érvényes munkamenet." }, 401, origin);
  }

  const token = authorization.slice("Bearer ".length);
  const userClient = createClient(supabaseUrl, apiKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser(token);

  if (userError || !userData.user) {
    return json({ error: "Nincs érvényes munkamenet." }, 401, origin);
  }

  const { data: claimsData, error: claimsError } = await userClient.auth.getClaims(
    token,
  );
  if (
    claimsError ||
    claimsData?.claims?.sub !== userData.user.id ||
    claimsData?.claims?.aal !== "aal2"
  ) {
    return json(
      { error: "A művelethez kétlépcsős hitelesítés szükséges." },
      403,
      origin,
    );
  }

  const serviceClient = createClient(supabaseUrl, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: admin, error: adminError } = await serviceClient
    .from("admin_users")
    .select("user_id")
    .eq("user_id", userData.user.id)
    .maybeSingle();

  if (adminError) {
    console.error("manual quote admin lookup failed", adminError.code);
    return json({ error: "A jogosultság ellenőrzése nem sikerült." }, 500, origin);
  }
  if (!admin) {
    return json({ error: "Ehhez a művelethez nincs adminjogosultságod." }, 403, origin);
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return json({ error: "Az űrlap nem olvasható." }, 400, origin);
  }

  const files = formData
    .getAll("files")
    .filter((item): item is File => item instanceof File && item.size > 0);

  if (files.length > 5) {
    return json({ error: "Legfeljebb 5 fájl tölthető fel." }, 400, origin);
  }

  for (const file of files) {
    if (
      !fileTypes[file.type] ||
      file.size > 10 * 1024 * 1024 ||
      !(await hasValidFileSignature(file))
    ) {
      return json(
        {
          error:
            "Csak JPG, PNG, WebP vagy PDF fájl tölthető fel, fájlonként legfeljebb 10 MB méretben.",
        },
        400,
        origin,
      );
    }
  }

  const action = text(formData, "action", 20) || "create";
  if (action === "append_files") {
    const rawQuoteId = text(formData, "quote_request_id", 30);
    const quoteId = /^[1-9][0-9]*$/.test(rawQuoteId)
      ? Number(rawQuoteId)
      : Number.NaN;
    const filePurpose = text(formData, "file_purpose", 40) || "reference";

    if (!Number.isSafeInteger(quoteId) || quoteId < 1 || !filePurposes.has(filePurpose)) {
      return json({ error: "Érvénytelen fájlfeltöltés." }, 400, origin);
    }
    if (!files.length) {
      return json({ error: "Válassz legalább egy feltöltendő fájlt." }, 400, origin);
    }

    const { data: existing, error: existingError } = await serviceClient
      .from("quote_requests")
      .select("id")
      .eq("id", quoteId)
      .maybeSingle();
    if (existingError) {
      console.error("manual quote file lookup failed", existingError.code);
      return json({ error: "A fájlfeltöltés most nem sikerült." }, 500, origin);
    }
    if (!existing) return json({ error: "Az ügy már nem található." }, 404, origin);

    const stored = await storeQuoteFiles(
      serviceClient,
      userData.user.id,
      quoteId,
      files,
      filePurpose,
    );
    if (!stored.ok) return json({ error: stored.message }, 500, origin);

    const { error: activityError } = await serviceClient
      .from("quote_activities")
      .insert({
        quote_request_id: quoteId,
        body: `${files.length} új fájl csatolva.`,
        created_by: userData.user.id,
      });
    if (activityError) {
      console.error("manual quote file activity failed", activityError.code);
    }

    return json({ ok: true, quoteId, uploaded: files.length }, 201, origin);
  }
  if (action !== "create") {
    return json({ error: "Érvénytelen művelet." }, 400, origin);
  }

  const entryType = text(formData, "entry_type", 30) || "quote_request";
  const requestKind = text(formData, "request_kind", 20) || "furniture";
  const source = text(formData, "source", 20);
  const customerName = text(formData, "customer_name", 100);
  const companyName = text(formData, "company_name", 100);
  const phone = text(formData, "phone", 40);
  const email = text(formData, "email", 254).toLowerCase();
  const rawProjectType = text(formData, "project_type", 30);
  const projectType = requestKind === "cutting" ? "cutting" : rawProjectType;
  const postcode = text(formData, "postcode", 20);
  const city = text(formData, "city", 120);
  const budgetRange = text(formData, "budget_range", 60);
  const preferredContact = text(formData, "preferred_contact", 10);
  const message = text(formData, "message", 5000);
  const approximateDimensions = text(
    formData,
    "approximate_dimensions",
    500,
  );
  const wantsCallback = checked(formData, "wants_callback");
  const wantsConsultation = checked(formData, "wants_consultation");
  const confirmedRequest = checked(formData, "confirmed_request");
  const submissionToken = text(formData, "submission_token", 36);
  const materialSource = text(formData, "material_source", 20) || "unknown";
  const fulfillment = text(formData, "fulfillment", 20) || "unknown";
  const targetDate = optionalDate(formData, "target_date");
  const address = text(formData, "address", 1000);
  const agreedTotal = optionalAmount(formData, "agreed_total");
  const depositPaid = optionalAmount(formData, "deposit_paid") ?? 0;
  const otherPaid = optionalAmount(formData, "other_paid") ?? 0;
  const promisedDate = optionalDate(formData, "promised_date");
  const nextAction = text(formData, "next_action", 500);
  const nextActionDate = optionalDate(formData, "next_action_date");
  const nextActionTime = text(formData, "next_action_time", 5);
  const nextActionKind = text(formData, "next_action_kind", 20);

  if (!entryTypes.has(entryType) || !requestKinds.has(requestKind)) {
    return json({ error: "Válassz érvényes felviteli és munkatípust." }, 400, origin);
  }
  const initialActivityBody = entryType === "direct_order"
    ? "Közvetlen rendelés kézzel rögzítve."
    : "Árajánlatkérés kézzel rögzítve.";
  if (!manualSources.has(source)) {
    return json({ error: "Válassz érvényes beérkezési módot." }, 400, origin);
  }
  if (customerName.length < 2 || customerName.length > 100) {
    return json({ error: "Az ügyfél neve 2–100 karakter lehet." }, 400, origin);
  }
  if (companyName && companyName.length < 2) {
    return json({ error: "A cégnév legalább 2 karakter legyen." }, 400, origin);
  }
  if (phone && (phone.length > 40 || phone.replace(/\D/g, "").length < 6)) {
    return json({ error: "Adj meg érvényes telefonszámot." }, 400, origin);
  }
  if (
    email &&
    (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
  ) {
    return json({ error: "Adj meg érvényes e-mail-címet." }, 400, origin);
  }
  if (!phone && !email) {
    return json(
      { error: "Legalább telefonszámot vagy e-mail-címet adj meg." },
      400,
      origin,
    );
  }
  if (source === "phone" && !phone) {
    return json(
      { error: "Telefonos megkereséshez add meg a telefonszámot." },
      400,
      origin,
    );
  }
  if (source === "email" && !email) {
    return json(
      { error: "E-mailes megkereséshez add meg az e-mail-címet." },
      400,
      origin,
    );
  }
  if (requestKind === "furniture" && projectType && !projectTypes.has(projectType)) {
    return json({ error: "Válassz érvényes bútortípust." }, 400, origin);
  }
  if (
    postcode.length > 20 ||
    city.length > 120 ||
    budgetRange.length > 60 ||
    approximateDimensions.length > 500
  ) {
    return json({ error: "Az egyik megadott szöveg túl hosszú." }, 400, origin);
  }
  if (message.length < 3 || message.length > 5000) {
    return json(
      { error: "A leírás legalább 3, legfeljebb 5000 karakter lehet." },
      400,
      origin,
    );
  }
  if (
    !preferredContacts.has(preferredContact) ||
    (preferredContact === "phone" && !phone) ||
    (preferredContact === "email" && !email)
  ) {
    return json(
      { error: "A választott kapcsolatfelvételi módhoz hiányzik az elérhetőség." },
      400,
      origin,
    );
  }
  if (!confirmedRequest) {
    return json(
      { error: "Erősítsd meg, hogy az ügyfél kérte a munka rögzítését." },
      400,
      origin,
    );
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      submissionToken,
    )
  ) {
    return json({ error: "A beküldés azonosítója érvénytelen." }, 400, origin);
  }
  if (
    requestKind === "cutting" &&
    (!cuttingMaterialSources.has(materialSource) ||
      !cuttingFulfillments.has(fulfillment) ||
      (fulfillment === "delivery" && !/^[1-9][0-9]{3}$/.test(postcode)))
  ) {
    return json({ error: "Ellenőrizd a lapszabászati átvételi adatokat." }, 400, origin);
  }
  if (targetDate === "invalid" || promisedDate === "invalid" || nextActionDate === "invalid") {
    return json({ error: "Az egyik dátum érvénytelen." }, 400, origin);
  }
  if (
    [agreedTotal, depositPaid, otherPaid].some(
      (value) => value !== null && (!Number.isFinite(value) || value < 0 || value > 999999999999),
    ) ||
    (agreedTotal !== null && depositPaid + otherPaid > agreedTotal)
  ) {
    return json({ error: "Ellenőrizd a megadott összegeket." }, 400, origin);
  }
  if (
    (nextAction && (!nextActionDate || !nextActionKinds.has(nextActionKind))) ||
    (!nextAction && (nextActionDate || nextActionTime || nextActionKind)) ||
    (nextActionTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(nextActionTime))
  ) {
    return json({ error: "Ellenőrizd a következő teendő adatait." }, 400, origin);
  }

  const { data: quote, error: quoteError } = await serviceClient
    .from("quote_requests")
    .insert({
      approximate_dimensions: approximateDimensions || null,
      budget_range: budgetRange || null,
      city: city || null,
      company_name: companyName || null,
      consent: null,
      customer_name: customerName,
      email: email || null,
      entered_by: userData.user.id,
      message: message || null,
      phone: phone || null,
      postcode: postcode || null,
      preferred_contact: preferredContact,
      project_type: projectType || null,
      request_kind: requestKind,
      request_confirmed_at: new Date().toISOString(),
      source,
      status: entryType === "direct_order" ? "ordered" : "needs_quote",
      submission_token: submissionToken,
      wants_callback: wantsCallback,
      wants_consultation: wantsConsultation,
      wants_quote: entryType === "quote_request",
    })
    .select("id,request_kind")
    .single();

  if (quoteError?.code === "23505") {
    const { data: existingQuote } = await serviceClient
      .from("quote_requests")
      .select("id,request_kind")
      .eq("submission_token", submissionToken)
      .eq("entered_by", userData.user.id)
      .neq("source", "website")
      .maybeSingle();

    if (existingQuote) {
      const existingId = Number(existingQuote.id);
      const existingKind = existingQuote.request_kind === "cutting"
        ? "cutting"
        : "furniture";
      const { data: readyWorkflow, error: workflowLookupError } = await serviceClient
        .from("quote_workflows")
        .select("quote_request_id")
        .eq("quote_request_id", existingId)
        .maybeSingle();
      const { data: readyActivity, error: activityLookupError } = await serviceClient
        .from("quote_activities")
        .select("id")
        .eq("quote_request_id", existingId)
        .eq("body", initialActivityBody)
        .limit(1)
        .maybeSingle();

      let cuttingReady = true;
      let cuttingLookupFailed = false;
      if (existingKind === "cutting") {
        const { data: readyCutting, error: cuttingLookupError } = await serviceClient
          .from("cutting_quote_requests")
          .select("quote_request_id")
          .eq("quote_request_id", existingId)
          .eq("submission_state", "ready")
          .maybeSingle();
        cuttingReady = Boolean(readyCutting);
        cuttingLookupFailed = Boolean(cuttingLookupError);
      }

      if (workflowLookupError || activityLookupError || cuttingLookupFailed) {
        console.error("manual quote duplicate readiness lookup failed");
        return json({ error: "A korábbi felvitel ellenőrzése nem sikerült." }, 500, origin);
      }
      if (!readyWorkflow || !readyActivity || !cuttingReady) {
        return json(
          { error: "A rögzítés még folyamatban van. Várj egy pillanatot, majd próbáld újra." },
          409,
          origin,
        );
      }

      return json(
        {
          ok: true,
          quoteId: existingId,
          reference: existingKind === "cutting"
            ? `HEPA-LSZ-${String(existingId).padStart(6, "0")}`
            : `HEPA-${String(existingId).padStart(6, "0")}`,
        },
        200,
        origin,
      );
    }
  }

  if (quoteError || !quote) {
    console.error("manual quote insert failed", quoteError?.code);
    return json({ error: "Az ajánlatkérés mentése nem sikerült." }, 500, origin);
  }

  const quoteId = Number(quote.id);
  if (requestKind === "cutting") {
    const payloadHash = await sha256Hex(
      JSON.stringify({ quoteId, submissionToken, message, targetDate }),
    );
    const { error: cuttingError } = await serviceClient
      .from("cutting_quote_requests")
      .insert({
        flow: files.length ? "upload" : "manual",
        fulfillment,
        material_source: materialSource,
        payload_hash: payloadHash,
        postal_code: fulfillment === "delivery" ? postcode : null,
        project_note: message.slice(0, 2000),
        quote_request_id: quoteId,
        size_basis: "finished",
        submission_state: "ready",
        target_date: targetDate,
      });
    if (cuttingError) {
      console.error("manual cutting detail insert failed", cuttingError.code);
      await rollbackQuote(serviceClient, quoteId, []);
      return json({ error: "A lapszabászati adatok mentése nem sikerült." }, 500, origin);
    }
  }

  const { error: workflowError } = await serviceClient
    .from("quote_workflows")
    .upsert({
      address: address || null,
      agreed_total: agreedTotal,
      deposit_paid: depositPaid,
      next_action: nextAction || null,
      next_action_date: nextAction ? nextActionDate : null,
      next_action_kind: nextAction ? nextActionKind : null,
      next_action_time: nextAction && nextActionTime ? nextActionTime : null,
      other_paid: otherPaid,
      promised_date: promisedDate,
      quote_request_id: quoteId,
      work_stage: entryType === "direct_order" && requestKind === "cutting"
        ? "cutting_received"
        : "not_started",
      updated_at: new Date().toISOString(),
    }, { onConflict: "quote_request_id" });
  if (workflowError) {
    console.error("manual quote workflow insert failed", workflowError.code);
    await rollbackQuote(serviceClient, quoteId, []);
    return json({ error: "A munkalap mentése nem sikerült." }, 500, origin);
  }

  const initialPurpose = entryType === "direct_order"
    ? "paper_order"
    : requestKind === "cutting"
    ? "cutting_list"
    : "reference";
  const stored = await storeQuoteFiles(
    serviceClient,
    userData.user.id,
    quoteId,
    files,
    initialPurpose,
  );
  if (!stored.ok) {
    await rollbackQuote(serviceClient, quoteId, []);
    return json({ error: stored.message }, 500, origin);
  }

  const { error: activityError } = await serviceClient
    .from("quote_activities")
    .insert({
      quote_request_id: quoteId,
      body: initialActivityBody,
      created_by: userData.user.id,
    });
  if (activityError) {
    console.error("manual quote activity insert failed", activityError.code);
    await rollbackQuote(serviceClient, quoteId, stored.uploadedPaths);
    return json({ error: "Az előzmény mentése nem sikerült." }, 500, origin);
  }

  return json(
    {
      ok: true,
      quoteId,
      reference: requestKind === "cutting"
        ? `HEPA-LSZ-${String(quoteId).padStart(6, "0")}`
        : `HEPA-${String(quoteId).padStart(6, "0")}`,
    },
    201,
    origin,
  );
});

