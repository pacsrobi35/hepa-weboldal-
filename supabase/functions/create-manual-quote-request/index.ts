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

  if (origin && allowedOrigins.has(origin)) {
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

Deno.serve(async (request: Request) => {
  const origin = request.headers.get("origin") ?? "";

  if (origin && !allowedOrigins.has(origin)) {
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

  const source = text(formData, "source", 20);
  const customerName = text(formData, "customer_name", 100);
  const phone = text(formData, "phone", 40);
  const email = text(formData, "email", 254).toLowerCase();
  const projectType = text(formData, "project_type", 30);
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
  const wantsQuote = checked(formData, "wants_quote");
  const wantsConsultation = checked(formData, "wants_consultation");
  const confirmedRequest = checked(formData, "confirmed_request");
  const submissionToken = text(formData, "submission_token", 36);

  if (!manualSources.has(source)) {
    return json({ error: "Válassz érvényes beérkezési módot." }, 400, origin);
  }
  if (customerName.length < 2 || customerName.length > 100) {
    return json({ error: "Az ügyfél neve 2–100 karakter lehet." }, 400, origin);
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
  if (projectType && !projectTypes.has(projectType)) {
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
      { error: "Erősítsd meg, hogy az ügyfél kérte az ajánlat elkészítését." },
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

  const { data: quote, error: quoteError } = await serviceClient
    .from("quote_requests")
    .insert({
      approximate_dimensions: approximateDimensions || null,
      budget_range: budgetRange || null,
      city: city || null,
      consent: null,
      customer_name: customerName,
      email: email || null,
      entered_by: userData.user.id,
      message: message || null,
      phone: phone || null,
      postcode: postcode || null,
      preferred_contact: preferredContact,
      project_type: projectType || null,
      request_confirmed_at: new Date().toISOString(),
      source,
      status: "new",
      submission_token: submissionToken,
      wants_callback: wantsCallback,
      wants_consultation: wantsConsultation,
      wants_quote: wantsQuote,
    })
    .select("id")
    .single();

  if (quoteError?.code === "23505") {
    const { data: existingQuote } = await serviceClient
      .from("quote_requests")
      .select("id")
      .eq("submission_token", submissionToken)
      .eq("entered_by", userData.user.id)
      .neq("source", "website")
      .maybeSingle();

    if (existingQuote) {
      const existingId = Number(existingQuote.id);
      return json(
        {
          ok: true,
          quoteId: existingId,
          reference: `HEPA-${String(existingId).padStart(6, "0")}`,
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
  const uploadedPaths: string[] = [];
  const fileRows: Array<Record<string, unknown>> = [];

  for (const file of files) {
    const extension = fileTypes[file.type];
    const storagePath =
      `manual/${userData.user.id}/${quoteId}/${crypto.randomUUID()}.${extension}`;
    const { error: uploadError } = await serviceClient.storage
      .from("quote-request-files")
      .upload(storagePath, file, {
        contentType: file.type,
        upsert: false,
      });

    if (uploadError) {
      console.error("manual quote file upload failed", uploadError.message);
      await rollbackQuote(serviceClient, quoteId, uploadedPaths);
      return json({ error: "A fájl feltöltése nem sikerült." }, 500, origin);
    }

    uploadedPaths.push(storagePath);
    fileRows.push({
      content_type: file.type,
      original_name: file.name.slice(0, 255) || `feltoltes.${extension}`,
      quote_request_id: quoteId,
      size_bytes: file.size,
      storage_path: storagePath,
    });
  }

  if (fileRows.length) {
    const { error: fileRowsError } = await serviceClient
      .from("quote_request_files")
      .insert(fileRows);

    if (fileRowsError) {
      console.error("manual quote file metadata insert failed", fileRowsError.code);
      await rollbackQuote(serviceClient, quoteId, uploadedPaths);
      return json({ error: "A fájl adatainak mentése nem sikerült." }, 500, origin);
    }
  }

  return json(
    {
      ok: true,
      quoteId,
      reference: `HEPA-${String(quoteId).padStart(6, "0")}`,
    },
    201,
    origin,
  );
});

