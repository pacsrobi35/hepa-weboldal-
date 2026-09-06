import { createClient } from "npm:@supabase/supabase-js@2.115.0";

const allowedOrigins = new Set([
  "https://hepa-weboldal.vercel.app",
  "https://hepa-konyhabutor.hu",
  "https://www.hepa-konyhabutor.hu",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]);

const typeMap: Record<string, string> = {
  "lapszabászat és élzárás": "other",
  "látványtervezés és bútorgyártás": "custom",
  "konyhabútor": "kitchen",
  "gardrób": "wardrobe",
  "előszobabútor": "entryway",
  "fürdőszobabútor": "bathroom",
  "nappali bútor": "living_room",
  "irodabútor": "office",
  "egyedi bútor": "custom",
  "egyéb": "other",
};

const fileTypes: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function startsWithBytes(bytes: Uint8Array, expected: number[], offset = 0) {
  return expected.every((value, index) => bytes[offset + index] === value);
}

async function hasValidFileSignature(file: File) {
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());

  switch (file.type) {
    case "image/jpeg":
      return startsWithBytes(bytes, [0xff, 0xd8, 0xff]);
    case "image/png":
      return startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/webp":
      return startsWithBytes(bytes, [0x52, 0x49, 0x46, 0x46]) &&
        startsWithBytes(bytes, [0x57, 0x45, 0x42, 0x50], 8);
    case "application/pdf":
      return startsWithBytes(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]);
    default:
      return false;
  }
}

type SupabaseClient = ReturnType<typeof createClient>;

function json(
  body: Record<string, unknown>,
  status: number,
  origin?: string,
  extraHeaders: Record<string, string> = {},
) {
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders,
  };

  if (origin && allowedOrigins.has(origin)) {
    headers["access-control-allow-origin"] = origin;
    headers["vary"] = "Origin";
  }

  return new Response(JSON.stringify(body), { status, headers });
}

function success(id: string | number, origin: string, status = 201) {
  return json({
    ok: true,
    message: "Köszönjük az érdeklődést! Hamarosan felvesszük Önnel a kapcsolatot.",
    reference: `HEPA-${String(id).padStart(6, "0")}`,
  }, status, origin);
}

function text(formData: FormData, name: string, maxLength: number) {
  const value = formData.get(name);
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength + 1);
}

function checked(formData: FormData, name: string) {
  return ["on", "true", "1"].includes(text(formData, name, 10).toLowerCase());
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

async function hmacSha256(keyMaterial: string, value: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(keyMaterial),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function clientAddress(request: Request) {
  const cloudflare = request.headers.get("cf-connecting-ip")?.trim();
  if (cloudflare) return cloudflare;

  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
}

async function rateLimitExceeded(
  supabase: SupabaseClient,
  request: Request,
  secretKey: string,
) {
  const address = clientAddress(request);
  if (!address) throw new Error("client-address-unavailable");

  const day = new Date().toISOString().slice(0, 10);
  const fingerprint = await hmacSha256(
    secretKey,
    `quote-rate-limit-v1\n${day}\n${address}`,
  );

  const { data, error } = await supabase.rpc("consume_quote_submission_limit", {
    p_fingerprint_hash: fingerprint,
    p_max_attempts: 5,
    p_window_seconds: 600,
  });

  if (error) {
    console.error("rate limit check failed", error.code);
    throw new Error("rate-limit-unavailable");
  }

  return data !== true;
}

async function sendQuoteNotification(details: {
  customerName: string;
  phone: string;
  email: string;
  furnitureLabel: string;
  message: string;
  dimensions: string;
  wantsCallback: boolean;
  wantsQuote: boolean;
  wantsConsultation: boolean;
  fileCount: number;
}) {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) return { sent: false, error: "resend-api-key-missing" };

  const requested = [
    details.wantsCallback ? "visszahívás" : "",
    details.wantsQuote ? "árajánlat" : "",
    details.wantsConsultation ? "személyes egyeztetés" : "",
  ].filter(Boolean).join(", ") || "nincs külön megjelölve";

  const body = [
    "Új bútorgyártási ajánlatkérés érkezett a weboldalról.",
    "",
    `Név: ${details.customerName}`,
    `Telefonszám: ${details.phone}`,
    `E-mail: ${details.email || "nincs megadva"}`,
    `Bútortípus: ${details.furnitureLabel || "nincs megadva"}`,
    `Hozzávetőleges méretek: ${details.dimensions || "nincs megadva"}`,
    `Kért kapcsolatfelvétel: ${requested}`,
    `Feltöltött fájlok száma: ${details.fileCount}`,
    "",
    "Leírás:",
    details.message || "nincs megadva",
  ].join("\n");

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from: Deno.env.get("QUOTE_NOTIFICATION_FROM") ||
          "HEPA ajánlatkérő <onboarding@resend.dev>",
        to: ["hepaconstructkft@gmail.com"],
        subject: "Új bútorgyártási ajánlatkérés érkezett",
        text: body,
        ...(details.email ? { reply_to: details.email } : {}),
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) {
      return { sent: false, error: `resend-http-${response.status}` };
    }

    return { sent: true, error: null };
  } catch (error) {
    return {
      sent: false,
      error: error instanceof DOMException && error.name === "TimeoutError"
        ? "resend-timeout"
        : "resend-request-failed",
    };
  }
}

Deno.serve(async (request) => {
  const origin = request.headers.get("origin") ?? "";

  if (!allowedOrigins.has(origin)) {
    return json({ error: "Ez a weboldal nem küldhet ajánlatkérést." }, 403);
  }

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "86400",
        "vary": "Origin",
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

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const secretKey = serviceRoleKey();

  if (!supabaseUrl || !secretKey) {
    return json({ error: "A szolgáltatás átmenetileg nem érhető el." }, 503, origin);
  }

  const supabase = createClient(supabaseUrl, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    if (await rateLimitExceeded(supabase, request, secretKey)) {
      return json(
        { error: "Túl sok próbálkozás érkezett. Kérjük, próbálja újra 10 perc múlva." },
        429,
        origin,
        { "retry-after": "600" },
      );
    }
  } catch {
    return json({ error: "A szolgáltatás átmenetileg nem érhető el." }, 503, origin);
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return json({ error: "Az űrlap nem olvasható." }, 400, origin);
  }

  if (text(formData, "company_website", 200)) {
    return json({ ok: true }, 200, origin);
  }

  const customerName = text(formData, "customer_name", 100);
  const phone = text(formData, "phone", 40);
  const emailValue = text(formData, "email", 254).toLowerCase();
  const furnitureLabel = text(formData, "project_type", 80);
  const message = text(formData, "message", 4000);
  const dimensions = text(formData, "approximate_dimensions", 500);
  const consent = checked(formData, "consent");
  const wantsCallback = checked(formData, "wants_callback");
  const wantsQuote = checked(formData, "wants_quote");
  const wantsConsultation = checked(formData, "wants_consultation");
  const requestedSubmissionToken = text(formData, "submission_token", 36);
  const submissionToken = uuidPattern.test(requestedSubmissionToken)
    ? requestedSubmissionToken
    : null;

  if (customerName.length < 2) {
    return json({ error: "Kérjük, adja meg a nevét." }, 400, origin);
  }

  if (customerName.length > 100) {
    return json({ error: "A név legfeljebb 100 karakter lehet." }, 400, origin);
  }

  if (phone.length > 40 || phone.replace(/\D/g, "").length < 6) {
    return json({ error: "Kérjük, adjon meg érvényes telefonszámot." }, 400, origin);
  }

  if (
    emailValue &&
    (emailValue.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailValue))
  ) {
    return json({ error: "Kérjük, adjon meg érvényes e-mail-címet." }, 400, origin);
  }

  if (message && (message.length < 3 || message.length > 4000)) {
    return json({ error: "A leírás legalább 3, legfeljebb 4000 karakter lehet." }, 400, origin);
  }

  if (dimensions.length > 500 || furnitureLabel.length > 80) {
    return json({ error: "Az egyik megadott szöveg túl hosszú." }, 400, origin);
  }

  if (!consent) {
    return json({ error: "Az adatkezelési hozzájárulás szükséges." }, 400, origin);
  }

  const files = formData
    .getAll("attachments")
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
        { error: "Csak JPG, PNG, WebP vagy PDF fájl tölthető fel, legfeljebb 10 MB méretben." },
        400,
        origin,
      );
    }
  }

  const { data: quote, error: quoteError } = await supabase
    .from("quote_requests")
    .insert({
      customer_name: customerName,
      phone,
      email: emailValue || null,
      project_type: typeMap[furnitureLabel.toLowerCase()] ?? (furnitureLabel ? "other" : null),
      message: message || null,
      approximate_dimensions: dimensions || null,
      wants_callback: wantsCallback,
      wants_quote: wantsQuote,
      wants_consultation: wantsConsultation,
      consent: true,
      source: "website",
      submission_token: submissionToken,
    })
    .select("id")
    .single();

  if (quoteError || !quote) {
    if (quoteError?.code === "23505" && submissionToken) {
      const { data: existing } = await supabase
        .from("quote_requests")
        .select("id")
        .eq("submission_token", submissionToken)
        .maybeSingle();

      if (existing) return success(existing.id, origin, 200);
    }

    console.error("quote insert failed", quoteError?.code);
    return json({ error: "Az ajánlatkérés mentése nem sikerült." }, 500, origin);
  }

  const uploadedPaths: string[] = [];
  const fileRows: Array<Record<string, unknown>> = [];

  for (const file of files) {
    const extension = fileTypes[file.type];
    const storagePath = `${quote.id}/${crypto.randomUUID()}.${extension}`;
    const { error: uploadError } = await supabase.storage
      .from("quote-request-files")
      .upload(storagePath, file, {
        contentType: file.type,
        upsert: false,
      });

    if (uploadError) {
      console.error("quote file upload failed", uploadError.message);
      if (uploadedPaths.length) {
        await supabase.storage.from("quote-request-files").remove(uploadedPaths);
      }
      await supabase.from("quote_requests").delete().eq("id", quote.id);
      return json({ error: "A fájl feltöltése nem sikerült." }, 500, origin);
    }

    uploadedPaths.push(storagePath);
    fileRows.push({
      quote_request_id: quote.id,
      storage_path: storagePath,
      original_name: file.name.slice(0, 255) || `feltoltes.${extension}`,
      content_type: file.type,
      size_bytes: file.size,
    });
  }

  if (fileRows.length) {
    const { error: fileRowsError } = await supabase
      .from("quote_request_files")
      .insert(fileRows);

    if (fileRowsError) {
      console.error("quote file metadata insert failed", fileRowsError.code);
      await supabase.storage.from("quote-request-files").remove(uploadedPaths);
      await supabase.from("quote_requests").delete().eq("id", quote.id);
      return json({ error: "A fájl adatainak mentése nem sikerült." }, 500, origin);
    }
  }

  const notification = await sendQuoteNotification({
    customerName,
    phone,
    email: emailValue,
    furnitureLabel,
    message,
    dimensions,
    wantsCallback,
    wantsQuote,
    wantsConsultation,
    fileCount: files.length,
  });

  const notificationUpdate = notification.sent
    ? { notification_sent_at: new Date().toISOString(), notification_error: null }
    : { notification_sent_at: null, notification_error: notification.error };
  const { error: notificationUpdateError } = await supabase
    .from("quote_requests")
    .update(notificationUpdate)
    .eq("id", quote.id);

  if (notificationUpdateError) {
    console.error("quote notification status update failed", notificationUpdateError.code);
  }

  return success(quote.id, origin);
});
