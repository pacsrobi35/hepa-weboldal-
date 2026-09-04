const { randomUUID } = require("node:crypto");

const MAX_BODY_BYTES = 64 * 1024;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_SERVICE_REQUESTS = new Set([
    "callback",
    "quote",
    "consultation"
]);

function send(response, statusCode, payload) {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    return response.status(statusCode).json(payload);
}

function text(value, maxLength) {
    if (typeof value !== "string") return "";
    return value.trim().slice(0, maxLength);
}

function parseBody(request) {
    if (request.body && typeof request.body === "object") {
        return request.body;
    }

    if (typeof request.body === "string") {
        return JSON.parse(request.body);
    }

    return {};
}

function isAllowedOrigin(request) {
    const origin = request.headers.origin;
    if (!origin) return true;

    const configuredOrigin = process.env.HEPA_ALLOWED_ORIGIN;
    if (configuredOrigin) {
        return origin === configuredOrigin.replace(/\/$/, "");
    }

    try {
        return new URL(origin).host === request.headers.host;
    } catch {
        return false;
    }
}

function validate(body) {
    const name = text(body.name, 120);
    const phone = text(body.phone, 40);
    const email = text(body.email, 160).toLowerCase();
    const furnitureType = text(body.furnitureType, 120);
    const description = text(body.description, 4000);
    const approximateDimensions = text(body.approximateDimensions, 1000);
    const rawServiceRequests = Array.isArray(body.serviceRequests)
        ? body.serviceRequests
        : [];
    const serviceRequests = [...new Set(
        rawServiceRequests
            .map((item) => text(item, 40))
            .filter((item) => ALLOWED_SERVICE_REQUESTS.has(item))
    )];

    const errors = {};

    if (name.length < 2) errors.name = "Kérjük, adja meg a nevét.";
    if (phone.length < 6) errors.phone = "Kérjük, adjon meg egy elérhető telefonszámot.";
    if (email && !EMAIL_PATTERN.test(email)) errors.email = "Az e-mail-cím formátuma nem megfelelő.";
    if (body.privacyAccepted !== true) errors.privacyAccepted = "Az adatkezelési hozzájárulás szükséges.";

    return {
        errors,
        data: {
            name,
            phone,
            email: email || null,
            furnitureType: furnitureType || null,
            description: description || null,
            approximateDimensions: approximateDimensions || null,
            serviceRequests
        }
    };
}

module.exports = async function handler(request, response) {
    if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        return send(response, 405, { ok: false, message: "Ez a művelet nem engedélyezett." });
    }

    if (!isAllowedOrigin(request)) {
        return send(response, 403, { ok: false, message: "A kérés forrása nem engedélyezett." });
    }

    const contentLength = Number(request.headers["content-length"] || 0);
    if (contentLength > MAX_BODY_BYTES) {
        return send(response, 413, { ok: false, message: "A beküldött adat túl nagy." });
    }

    let body;
    try {
        body = parseBody(request);
    } catch {
        return send(response, 400, { ok: false, message: "A beküldött adatok nem olvashatók." });
    }

    // Rejtett mező: a kitöltő robotok választ kapnak, de nem kerülnek az adatbázisba.
    if (text(body.website, 200)) {
        return send(response, 201, { ok: true, reference: null });
    }

    const { errors, data } = validate(body);
    if (Object.keys(errors).length) {
        return send(response, 422, {
            ok: false,
            message: "Kérjük, ellenőrizze a megadott adatokat.",
            errors
        });
    }

    const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, "");
    const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;

    if (!supabaseUrl || !supabaseSecretKey) {
        return send(response, 503, {
            ok: false,
            message: "Az online ajánlatkérés még nincs összekapcsolva. Kérjük, keressen minket telefonon vagy e-mailben."
        });
    }

    const requestedToken = text(body.submissionToken, 36);
    const submissionToken = UUID_PATTERN.test(requestedToken)
        ? requestedToken
        : randomUUID();

    try {
        const supabaseResponse = await fetch(`${supabaseUrl}/rest/v1/rpc/create_quote_request`, {
            method: "POST",
            headers: {
                apikey: supabaseSecretKey,
                Authorization: `Bearer ${supabaseSecretKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                p_submission_token: submissionToken,
                p_name: data.name,
                p_phone: data.phone,
                p_email: data.email,
                p_furniture_type: data.furnitureType,
                p_description: data.description,
                p_approx_dimensions: data.approximateDimensions,
                p_service_requests: data.serviceRequests,
                p_source_metadata: {
                    page: text(body.page, 240) || "/",
                    referrer: text(body.referrer, 500) || null
                }
            })
        });

        if (!supabaseResponse.ok) {
            console.error("Quote request database error", {
                status: supabaseResponse.status,
                requestId: supabaseResponse.headers.get("x-request-id")
            });
            return send(response, 502, {
                ok: false,
                message: "Az ajánlatkérést most nem sikerült elküldeni. Kérjük, próbálja újra, vagy keressen minket telefonon."
            });
        }

        const result = await supabaseResponse.json();
        const created = Array.isArray(result) ? result[0] : result;

        return send(response, 201, {
            ok: true,
            reference: created?.job_number || null
        });
    } catch (error) {
        console.error("Quote request connection error", { name: error?.name || "Error" });
        return send(response, 502, {
            ok: false,
            message: "Az ajánlatkérést most nem sikerült elküldeni. Kérjük, próbálja újra, vagy keressen minket telefonon."
        });
    }
};

