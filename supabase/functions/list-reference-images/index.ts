import { createClient } from "npm:@supabase/supabase-js@2.115.0";

const allowedOrigins = new Set([
  "https://hepa-weboldal.vercel.app",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]);

function corsHeaders(origin: string) {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "apikey, authorization, content-type",
    "cache-control": "no-store, max-age=0",
    "content-type": "application/json; charset=utf-8",
    "vary": "Origin",
  };
}

function json(body: Record<string, unknown>, status: number, origin: string) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders(origin) });
}

function publicObjectUrl(supabaseUrl: string, storagePath: string) {
  const encodedPath = storagePath.split("/").map(encodeURIComponent).join("/");
  return `${supabaseUrl}/storage/v1/object/public/reference-images/${encodedPath}`;
}

Deno.serve(async (request: Request) => {
  const origin = request.headers.get("origin") ?? "";
  if (!allowedOrigins.has(origin)) {
    return new Response(JSON.stringify({ error: "origin-not-allowed" }), {
      status: 403,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (request.method !== "GET") {
    return json({ error: "method-not-allowed" }, 405, origin);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !anonKey) {
    console.error("Supabase function secrets are unavailable");
    return json({ error: "configuration-error" }, 500, origin);
  }

  const supabase = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase
    .from("reference_images")
    .select("id, category, storage_path, alt_text, sort_order, created_at")
    .eq("is_published", true)
    .order("category")
    .order("sort_order")
    .order("created_at", { ascending: false })
    .limit(300);

  if (error) {
    console.error("Reference image query failed", error.code);
    return json({ error: "query-failed" }, 500, origin);
  }

  const images = (data ?? []).map((image) => ({
    id: image.id,
    category: image.category,
    alt: image.alt_text,
    url: publicObjectUrl(supabaseUrl, image.storage_path),
  }));

  return json({ images }, 200, origin);
});
