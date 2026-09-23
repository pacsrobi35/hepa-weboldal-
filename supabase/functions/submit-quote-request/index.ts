import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.115.0";

const allowedOrigins = new Set([
  "https://hepa-weboldal.vercel.app",
  "https://hepabutor.hu",
  "https://www.hepabutor.hu",
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

  const payload = status >= 400
    ? { ok: false, code: status === 429 ? "rate-limit-exceeded" : status >= 500 ? "service-unavailable" : "validation-failed", retryable: status >= 500 || status === 429, ...body }
    : body;
  return new Response(JSON.stringify(payload), { status, headers });
}

function success(id: string | number, origin: string, status = 201, duplicate = false) {
  return json({
    ok: true,
    state: "ready",
    duplicate,
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
  quoteId: number;
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
        "idempotency-key": `hepa-furniture-new-${details.quoteId}`,
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

    const result = await response.json().catch(() => null);
    if (!result?.id) return { sent: false, error: "resend-response-missing-id" };
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

async function handleRequest(request: Request) {
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
  if (!uuidPattern.test(requestedSubmissionToken)) {
    return json({ code: "invalid-submission-token", error: "Az ajánlatkérés azonosítója hibás. Frissítse az oldalt, majd próbálja újra." }, 400, origin);
  }
  const submissionToken = requestedSubmissionToken;

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

  const fileManifest = [];
  for (const file of files) {
    fileManifest.push({
      original_name: file.name.slice(0, 255) || `feltoltes.${fileTypes[file.type]}`,
      content_type: file.type,
      size_bytes: file.size,
      content_sha256: await sha256(await file.arrayBuffer()),
    });
  }
  const requestDetails = {
    customer_name: customerName,
    phone,
    email: emailValue || null,
    project_type: typeMap[furnitureLabel.toLowerCase()] ?? (furnitureLabel ? "other" : null),
    message: message || null,
    approximate_dimensions: dimensions || null,
    wants_callback: wantsCallback,
    wants_quote: wantsQuote,
    wants_consultation: wantsConsultation,
  };
  const payloadHash = await sha256(new TextEncoder().encode(JSON.stringify({
    request: requestDetails,
    furnitureLabel,
    files: fileManifest,
  })));
  const { data: startedData, error: startError } = await supabase.rpc(
    "begin_furniture_quote_submission",
    {
      p_submission_token: submissionToken,
      p_payload_hash: payloadHash,
      p_expected_files: files.length,
      p_request: requestDetails,
    },
  );
  if (startError) {
    console.error("furniture submission begin failed", startError.code);
    return json({ code: "save-unconfirmed", error: "Az ajánlatkérés mentése még nem igazolható. Az űrlap adatait megtartottuk; próbálja újra." }, 503, origin);
  }
  const started = firstRow(startedData);
  const quoteId = Number(started?.quote_id);
  if (started?.state === "conflict" || started?.state === "legacy") {
    const reference = Number.isSafeInteger(quoteId) && quoteId > 0
      ? `HEPA-${String(quoteId).padStart(6, "0")}` : null;
    return json({
      code: started.state === "legacy" ? "legacy-submission-unconfirmed" : "submission-token-conflict",
      error: started.state === "legacy"
        ? "A korábbi beküldést megtaláltuk, de a teljes mentését nem tudjuk automatikusan ellenőrizni. Kérjük, egyeztessen velünk a hivatkozási számmal."
        : "A korábbi beküldéshez képest megváltoztak az adatok vagy a fájlok. A módosításokat nem mentettük; kérjük, egyeztessen velünk a hivatkozási számmal.",
      reference,
      retryable: false,
    }, 409, origin);
  }
  if (!started || !Number.isSafeInteger(quoteId) || quoteId < 1 || typeof started.state !== "string" || !["ingesting", "ready"].includes(started.state)) {
    return json({ code: "save-unconfirmed", error: "A mentést nem sikerült ellenőrizni. Próbálja újra ugyanazt a beküldést." }, 503, origin);
  }

  if (started.state === "ingesting") {
    const fileRows = [];
    for (const [index, file] of files.entries()) {
      const metadata = fileManifest[index];
      const storagePath = `furniture/${quoteId}/${String(index + 1).padStart(2, "0")}-${metadata.content_sha256.slice(0, 24)}.${fileTypes[file.type]}`;
      const { error: uploadError } = await supabase.storage
        .from("quote-request-files")
        .upload(storagePath, file, { contentType: file.type, upsert: false });
      if (uploadError) {
        // A retry or concurrent request may have stored this immutable object.
        // Never overwrite it or trust only its name: verify the actual bytes.
        const { data: existingFile, error: readError } = await supabase.storage
          .from("quote-request-files").download(storagePath);
        if (readError || !existingFile) {
          console.error("furniture file upload unconfirmed", uploadError.message);
          return json({ code: "file-upload-incomplete", error: "A fájlok feltöltése nem fejeződött be. Az adatok megmaradtak; próbálja újra ugyanazt a beküldést." }, 503, origin, { "retry-after": "3" });
        }
        if (existingFile.size !== file.size || await sha256(await existingFile.arrayBuffer()) !== metadata.content_sha256) {
          return json({ code: "file-content-conflict", retryable: false, error: "Az egyik melléklet tartalmát nem sikerült biztonságosan egyeztetni. Kérjük, vegye fel velünk a kapcsolatot." }, 409, origin);
        }
      }
      fileRows.push({ ...metadata, storage_path: storagePath });
    }
    // The RPC atomically checks stored objects, registers all files, and marks ready.
    // Repeating it also handles a successful commit whose response was lost.
    let finalized = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { data, error } = await supabase.rpc("finalize_furniture_quote_submission", {
        p_quote_id: quoteId,
        p_payload_hash: payloadHash,
        p_files: fileRows,
      });
      if (!error && firstRow(data)?.state === "ready") { finalized = true; break; }
      console.error("furniture submission finalize unconfirmed", error?.code);
    }
    if (!finalized) {
      return json({ code: "finalize-unconfirmed", error: "A beküldés eredményét még nem sikerült ellenőrizni. Az adatok megmaradtak; próbálja újra ugyanazt a beküldést." }, 503, origin, { "retry-after": "3" });
    }
  }

  // Notification failure must not turn a safely stored inquiry into a failed one.
  try {
    const { data: claimed, error: claimError } = await supabase.rpc("claim_furniture_quote_notification", {
      p_quote_id: quoteId, p_payload_hash: payloadHash,
    });
    if (claimError) console.error("furniture notification claim unconfirmed", claimError.code);
    if (!claimError && claimed === true) {
      const notification = await sendQuoteNotification({
        quoteId, customerName, phone, email: emailValue, furnitureLabel, message,
        dimensions, wantsCallback, wantsQuote, wantsConsultation, fileCount: files.length,
      });
      const update = notification.sent
        ? { notification_sent_at: new Date().toISOString(), notification_error: null }
        : { notification_error: notification.error };
      const { error } = await supabase.from("quote_requests").update(update)
        .eq("id", quoteId).is("notification_sent_at", null);
      if (error) console.error("furniture notification state update failed", error.code);
    }
  } catch {
    console.error("furniture notification attempt failed");
  }
  return success(quoteId, origin, started.duplicate ? 200 : 201, Boolean(started.duplicate));
}

async function sha256(value: BufferSource) {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function firstRow(value: unknown): Record<string, unknown> | null {
  const row = Array.isArray(value) ? value[0] : value;
  return row && typeof row === "object" ? row as Record<string, unknown> : null;
}

Deno.serve(async (request: Request) => {
  try {
    return await handleRequest(request);
  } catch {
    console.error("unexpected furniture submission failure");
    return json({ code: "save-unconfirmed", error: "A beküldés eredményét még nem sikerült ellenőrizni. Az űrlap adatait megtartottuk; próbálja újra." }, 503, request.headers.get("origin") ?? "");
  }
});
