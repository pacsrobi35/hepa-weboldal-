import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.115.0";

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

type ServiceClient = SupabaseClient<any>;

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

function optionalAmountInCents(formData: FormData, name: string) {
  const raw = text(formData, name, 30).replace(/\s/g, "").replace(",", ".");
  if (!raw) return null;
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) return Number.NaN;
  const [whole, fraction = ""] = raw.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents <= 99999999999900
    ? cents : Number.NaN;
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

async function fileSha256Hex(file: Blob) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

type PreparedFile = { file: File; sha256: string };

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

async function storeQuoteFiles(
  supabase: ServiceClient,
  quoteId: number,
  files: PreparedFile[],
  filePurpose: string,
) {
  if (!files.length) {
    return { ok: true as const, uploaded: 0, alreadyPresent: 0 };
  }
  const hashes = files.map(({ sha256 }) => sha256);
  const { data: existingFiles, error: lookupError } = await supabase
    .from("quote_request_files")
    .select("content_sha256")
    .eq("quote_request_id", quoteId)
    .eq("file_purpose", filePurpose)
    .in("content_sha256", hashes);
  if (lookupError) {
    console.error("manual quote file duplicate lookup failed", lookupError.code);
    return { ok: false as const, uploaded: 0, alreadyPresent: 0, status: 500,
      message: "A meglévő fájlok ellenőrzése nem sikerült." };
  }
  const existingHashes = new Set(existingFiles?.map((row) => row.content_sha256));
  let alreadyPresent = 0;
  let uploaded = 0;

  for (const { file, sha256 } of files) {
    if (existingHashes.has(sha256)) {
      alreadyPresent++;
      continue;
    }
    const extension = fileTypes[file.type];
    const storagePath =
      `manual/${quoteId}/${filePurpose}/${sha256}.${extension}`;
    const { error: uploadError } = await supabase.storage
      .from("quote-request-files")
      .upload(storagePath, file, {
        contentType: file.type,
        upsert: false,
      });

    if (uploadError) {
      const alreadyStored = ("code" in uploadError &&
          uploadError.code === "ResourceAlreadyExists") ||
        uploadError.status === 409 || uploadError.statusCode === "409" ||
        ((uploadError.status === 400 || uploadError.statusCode === "400") &&
          /Asset Already Exists/i.test(uploadError.message));
      if (!alreadyStored) {
        console.error("manual quote file upload failed", uploadError.message);
        return { ok: false as const, uploaded, alreadyPresent, status: 500,
          message: "A fájl feltöltése nem sikerült." };
      }
      // A previous attempt may have uploaded the object but died before saving
      // its metadata. Verify its bytes before attaching it on this retry.
      const { data: storedBlob, error: downloadError } = await supabase.storage
        .from("quote-request-files").download(storagePath);
      if (downloadError || !storedBlob ||
          await fileSha256Hex(storedBlob) !== sha256) {
        return { ok: false as const, uploaded, alreadyPresent, status: 409,
          message: "A fájl feltöltése még folyamatban van. Várj egy pillanatot, majd próbáld újra." };
      }
    }

    const { error: fileRowError } = await supabase
      .from("quote_request_files")
      .insert({
        content_sha256: sha256,
        content_type: file.type,
        file_purpose: filePurpose,
        original_name: file.name.slice(0, 255) || `feltoltes.${extension}`,
        quote_request_id: quoteId,
        size_bytes: file.size,
        storage_path: storagePath,
      });
    if (fileRowError) {
      if (fileRowError.code === "23505") {
        const { data: existingRow, error: retryLookupError } = await supabase
          .from("quote_request_files")
          .select("id")
          .eq("quote_request_id", quoteId)
          .eq("file_purpose", filePurpose)
          .eq("content_sha256", sha256)
          .maybeSingle();
        if (!retryLookupError && existingRow) {
          alreadyPresent++;
          continue;
        }
      }
      console.error("manual quote file metadata insert failed", fileRowError.code);
      return { ok: false as const, uploaded, alreadyPresent, status: 500,
        message: "A fájl adatainak mentése nem sikerült. Próbáld újra ugyanazokkal a fájlokkal." };
    }
    uploaded++;
  }

  return { ok: true as const, uploaded, alreadyPresent };
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

  const preparedFiles: PreparedFile[] = [];
  const batchHashes = new Set<string>();
  for (const file of files) {
    const sha256 = await fileSha256Hex(file);
    if (batchHashes.has(sha256)) {
      return json({ error: "Ugyanazt a fájlt csak egyszer válaszd ki." }, 400, origin);
    }
    batchHashes.add(sha256);
    preparedFiles.push({ file, sha256 });
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
      quoteId,
      preparedFiles,
      filePurpose,
    );
    if (stored.uploaded > 0) {
      const { error: activityError } = await serviceClient
        .from("quote_activities")
        .insert({
          quote_request_id: quoteId,
          body: `${stored.uploaded} új fájl csatolva.`,
          created_by: userData.user.id,
        });
      if (activityError) {
        console.error("manual quote file activity failed", activityError.code);
      }
    }
    if (!stored.ok) return json({ error: stored.message }, stored.status, origin);

    return json({ ok: true, quoteId, uploaded: stored.uploaded, alreadyPresent: stored.alreadyPresent },
      stored.uploaded ? 201 : 200, origin);
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
  const agreedTotalCents = optionalAmountInCents(formData, "agreed_total");
  const depositPaidCents = optionalAmountInCents(formData, "deposit_paid") ?? 0;
  const otherPaidCents = optionalAmountInCents(formData, "other_paid") ?? 0;
  const promisedDate = optionalDate(formData, "promised_date");
  const nextAction = text(formData, "next_action", 500);
  const nextActionDate = optionalDate(formData, "next_action_date");
  const nextActionTime = text(formData, "next_action_time", 5);
  const nextActionKind = text(formData, "next_action_kind", 20);

  if (!entryTypes.has(entryType) || !requestKinds.has(requestKind)) {
    return json({ error: "Válassz érvényes felviteli és munkatípust." }, 400, origin);
  }
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
    [agreedTotalCents, depositPaidCents, otherPaidCents].some(
      (value) => value !== null && (!Number.isSafeInteger(value) || value < 0 || value > 99999999999900),
    ) ||
    (agreedTotalCents !== null && depositPaidCents + otherPaidCents > agreedTotalCents)
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

  // A reused submission token may only acknowledge the exact same request.
  // Preserve the first payload's hash so edits after an uncertain response
  // cannot silently open an older, different order as though it were saved.
  const manualPayloadHash = await sha256Hex(JSON.stringify({
    entryType, requestKind, source, customerName, companyName, phone, email,
    projectType, postcode, city, budgetRange, preferredContact, message,
    approximateDimensions, wantsCallback, wantsConsultation, confirmedRequest,
    materialSource: requestKind === "cutting" ? materialSource : null,
    fulfillment: requestKind === "cutting" ? fulfillment : null,
    targetDate: requestKind === "cutting" ? targetDate : null,
    address: entryType === "direct_order" ? address : null,
    agreedTotalCents: entryType === "direct_order" ? agreedTotalCents : null,
    depositPaidCents: entryType === "direct_order" ? depositPaidCents : null,
    otherPaidCents: entryType === "direct_order" ? otherPaidCents : null,
    promisedDate: entryType === "direct_order" ? promisedDate : null,
    nextAction: entryType === "direct_order" ? nextAction : null,
    nextActionDate: entryType === "direct_order" ? nextActionDate : null,
    nextActionTime: entryType === "direct_order" ? nextActionTime : null,
    nextActionKind: entryType === "direct_order" ? nextActionKind : null,
    files: preparedFiles.map(({ file, sha256 }) => ({
      sha256, name: file.name.slice(0, 255), type: file.type, size: file.size,
    })),
  }));

  const initialPurpose = entryType === "direct_order"
    ? "paper_order"
    : requestKind === "cutting"
    ? "cutting_list"
    : "reference";
  const { data: initialized, error: initializeError } = await serviceClient.rpc(
    "create_manual_quote_request",
    { p_request: {
      submission_token: submissionToken,
      entered_by: userData.user.id,
      payload_hash: manualPayloadHash,
      request_kind: requestKind,
      entry_type: entryType,
      expected_files: files.length,
      quote: {
        approximate_dimensions: approximateDimensions,
        budget_range: budgetRange,
        city, company_name: companyName,
        customer_name: customerName, email, message, phone, postcode,
        preferred_contact: preferredContact, project_type: projectType,
        source, wants_callback: wantsCallback,
        wants_consultation: wantsConsultation,
      },
      cutting: requestKind === "cutting" ? {
        fulfillment, material_source: materialSource,
        postal_code: fulfillment === "delivery" ? postcode : null,
        project_note: message.slice(0, 2000), target_date: targetDate,
      } : null,
      workflow: {
        address: address || null,
        agreed_total: agreedTotalCents === null ? null : agreedTotalCents / 100,
        deposit_paid: depositPaidCents / 100,
        next_action: nextAction || null,
        next_action_date: nextAction ? nextActionDate : null,
        next_action_kind: nextAction ? nextActionKind : null,
        next_action_time: nextAction && nextActionTime ? nextActionTime : null,
        other_paid: otherPaidCents / 100,
        promised_date: promisedDate,
      },
    } },
  );
  if (initializeError || !initialized || typeof initialized !== "object") {
    console.error("manual quote initialization failed", initializeError?.code);
    return json({ error: "Az ügy létrehozása nem sikerült. Próbáld újra." }, 500, origin);
  }
  const quoteId = Number(initialized.quote_id);
  const reference = Number.isSafeInteger(quoteId) && quoteId > 0
    ? requestKind === "cutting"
      ? `HEPA-LSZ-${String(quoteId).padStart(6, "0")}`
      : `HEPA-${String(quoteId).padStart(6, "0")}`
    : null;
  if (initialized.state === "conflict") {
    return json({
      error: "Ezzel a beküldéssel már létrejött egy ügy, de az űrlap azóta megváltozott. Nyisd meg a korábbi ügyet, és ott végezd el a módosításokat.",
      ...(reference ? { quoteId, reference } : {}),
    }, 409, origin);
  }
  if (!reference || !["ingesting", "ready"].includes(initialized.state)) {
    console.error("manual quote initialization returned an invalid result");
    return json({ error: "A felvitel eredményét nem sikerült ellenőrizni. Próbáld újra." }, 500, origin);
  }

  // An identical retry resumes missing files. The initializer never repeats
  // the quote/workflow/activity inserts, and each file is stored by its hash.
  const stored = await storeQuoteFiles(
    serviceClient, quoteId, preparedFiles, initialPurpose,
  );
  if (!stored.ok) {
    return json({
      error: `Az ügy létrejött (${reference}), de a csatolmányok mentése nem fejeződött be. Próbáld újra ugyanebből az űrlapból. ${stored.message}`,
      quoteId, reference,
    }, stored.status, origin);
  }
  const { data: ready, error: finalizeError } = await serviceClient.rpc(
    "finalize_manual_quote_request",
    {
      p_quote_id: quoteId,
      p_submission_token: submissionToken,
      p_payload_hash: manualPayloadHash,
      p_expected_files: preparedFiles.map(({ sha256 }) => ({
        sha256, purpose: initialPurpose,
      })),
    },
  );
  if (finalizeError || ready !== true) {
    console.error("manual quote finalization failed", finalizeError?.code);
    return json({
      error: `Az ügy létrejött (${reference}), de a csatolmányok ellenőrzése nem fejeződött be. Próbáld újra ugyanebből az űrlapból.`,
      quoteId, reference,
    }, 500, origin);
  }

  return json(
    {
      ok: true,
      quoteId,
      reference,
    },
    initialized.duplicate ? 200 : 201,
    origin,
  );
});
