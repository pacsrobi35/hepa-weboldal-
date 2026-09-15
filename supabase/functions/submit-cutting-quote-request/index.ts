import { createClient } from "npm:@supabase/supabase-js@2.115.0";

const MAX_REQUEST_BYTES = 18 * 1024 * 1024;
const MAX_FILE_BYTES = 6 * 1024 * 1024;
const MAX_TOTAL_FILE_BYTES = 15 * 1024 * 1024;
const MAX_FILES = 5;
const MAX_PAYLOAD_BYTES = 1024 * 1024;

const allowedOrigins = new Set([
  "https://hepa-weboldal.vercel.app",
  "https://hepabutor.hu",
  "https://www.hepabutor.hu",
  "https://hepa-weboldal-git-lapszabaszat-fejlesztes-hepa-construct.vercel.app",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]);

const previewOrigins = new Set([
  "https://hepa-weboldal-git-lapszabaszat-fejlesztes-hepa-construct.vercel.app",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]);

const flowLabels = {
  manual: "Tételek kézi megadása",
  upload: "Szabászjegyzék feltöltése",
  help: "Segítségkérés",
} as const;

const materialSourceLabels = {
  hepa: "A HEPA szerzi be",
  own: "Saját / hozott anyag",
  unknown: "Még nem tudja",
} as const;

const fulfillmentLabels = {
  pickup: "Személyes átvétel Aszódon",
  delivery: "Szállítást kér",
  unknown: "Még nem tudja",
} as const;

const helpTopicLabels = {
  material: "anyag vagy dekor",
  size: "méretek és szabászjegyzék",
  edge: "ABS élzárás",
  delivery: "átvétel vagy szállítás",
} as const;

const edgeCodeLabels: Record<string, string> = {
  "0-0": "nincs élzárás",
  "0-1": "1 rövid él",
  "0-2": "2 rövid él",
  "1-0": "1 hosszanti él",
  "1-1": "1 hosszanti + 1 rövid él",
  "1-2": "1 hosszanti + 2 rövid él",
  "2-0": "2 hosszanti él",
  "2-1": "2 hosszanti + 1 rövid él",
  "2-2": "mind a 4 él",
};

const edgeCodes = new Set(Object.keys(edgeCodeLabels));
const materialSources = new Set(["hepa", "own", "unknown"]);
const fulfillments = new Set(["pickup", "delivery", "unknown"]);
const helpTopics = new Set(["material", "size", "edge", "delivery"]);
const flows = new Set(["manual", "upload", "help"]);

type Flow = "manual" | "upload" | "help";
type MaterialSource = "hepa" | "own" | "unknown";
type Fulfillment = "pickup" | "delivery" | "unknown";
type PreferredContact = "email" | "phone";

type SupabaseClient = ReturnType<typeof createClient>;

type Contact = {
  name: string;
  companyName: string;
  email: string;
  phone: string;
  preferredContact: PreferredContact;
};

type Logistics = {
  fulfillment: Fulfillment;
  postalCode: string;
  targetDate: string;
  note: string;
};

type Material = {
  clientId: string;
  name: string;
  thicknessMm: number;
  displayOrder: number;
};

type CuttingItem = {
  materialClientId: string;
  name: string;
  lengthMm: number;
  widthMm: number;
  quantity: number;
  edgeCode: string;
  edgeMaterialType: string;
  note: string;
  displayOrder: number;
};

type Totals = {
  rows: number;
  pieces: number;
  areaM2: number;
  edgeM: number;
};

type ValidatedPayload = {
  schemaVersion: 1;
  flow: Flow;
  sizeBasis: "finished";
  contact: Contact;
  logistics: Logistics | null;
  materialSource: MaterialSource | null;
  upload: {
    material: string;
    thicknessMm: number | null;
    note: string;
  } | null;
  help: {
    topics: string[];
    description: string;
  } | null;
  materials: Material[];
  items: CuttingItem[];
  totals: Totals;
};

type FileFormat = "jpg" | "png" | "pdf" | "xlsx" | "csv";

type ValidatedFile = {
  file: File;
  extension: FileFormat;
  contentType: string;
  originalName: string;
  contentHash: string;
};

class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

function fail(message: string): never {
  throw new InputError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) fail(`A(z) ${label} adatai hiányoznak vagy hibásak.`);
  return value;
}

function fieldText(
  value: unknown,
  label: string,
  maxLength: number,
  minLength = 0,
  multiline = false,
) {
  if (value === undefined || value === null) value = "";
  if (typeof value !== "string") fail(`A(z) ${label} mező hibás.`);
  const normalized = multiline
    ? value.replace(/\r\n?/g, "\n").trim()
    : value.trim().replace(/\s+/g, " ");

  if (normalized.length > maxLength) {
    fail(`A(z) ${label} mező legfeljebb ${maxLength} karakter lehet.`);
  }
  if (normalized.length < minLength) {
    fail(`A(z) ${label} mező legalább ${minLength} karakter legyen.`);
  }
  return normalized;
}

function numericField(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
  integer = false,
) {
  let normalized: number;
  if (typeof value === "number") {
    normalized = value;
  } else if (typeof value === "string") {
    const raw = value.trim().replace(",", ".");
    if (!/^\d+(?:\.\d{1,3})?$/.test(raw)) fail(`A(z) ${label} mező hibás.`);
    normalized = Number(raw);
  } else {
    fail(`A(z) ${label} mező hibás.`);
  }

  if (
    !Number.isFinite(normalized) ||
    normalized < minimum ||
    normalized > maximum ||
    (integer && !Number.isInteger(normalized))
  ) {
    fail(`A(z) ${label} mező értéke nem megengedett.`);
  }
  return normalized;
}

function optionalNumber(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
) {
  if (value === undefined || value === null || value === "") return null;
  return numericField(value, label, minimum, maximum);
}

function enumValue<T extends string>(
  value: unknown,
  allowed: Set<string>,
  label: string,
): T {
  if (typeof value !== "string" || !allowed.has(value)) {
    fail(`A(z) ${label} mező értéke nem megengedett.`);
  }
  return value as T;
}

function validDate(value: unknown, label: string) {
  const text = fieldText(value, label, 10);
  if (!text) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) fail(`A(z) ${label} dátum hibás.`);
  const parsed = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== text) {
    fail(`A(z) ${label} dátum hibás.`);
  }
  return text;
}

function budapestToday() {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Europe/Budapest",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function round(value: number, decimals = 3) {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function parseContact(value: unknown, privacyConsent: unknown): Contact {
  const source = record(value, "kapcsolattartás");
  const name = fieldText(source.name, "név", 100, 2);
  const companyName = fieldText(source.companyName, "cégnév", 100);
  if (companyName && companyName.length < 2) {
    fail("A cégnév legalább 2 karakter legyen.");
  }
  const email = fieldText(source.email, "e-mail-cím", 254).toLowerCase();
  const phone = fieldText(source.phone, "telefonszám", 40);

  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    fail("Kérjük, adjon meg érvényes e-mail-címet.");
  }

  const compactPhone = phone.replace(/[\s().\/-]/g, "");
  const phoneDigits = phone.replace(/\D/g, "");
  if (
    phone &&
    (!/^\+?\d+$/.test(compactPhone) ||
      phoneDigits.length < 7 ||
      phoneDigits.length > 15)
  ) {
    fail("Kérjük, adjon meg érvényes telefonszámot.");
  }
  if (!email && !phone) {
    fail("Az e-mail-cím vagy a telefonszám közül legalább az egyik szükséges.");
  }

  const preferredContact = enumValue<PreferredContact>(
    source.preferredContact,
    new Set(["email", "phone"]),
    "elsődleges kapcsolattartás",
  );
  if (preferredContact === "email" && !email) {
    fail("E-mailes kapcsolattartáshoz adja meg az e-mail-címét.");
  }
  if (preferredContact === "phone" && !phone) {
    fail("Telefonos kapcsolattartáshoz adja meg a telefonszámát.");
  }
  if (privacyConsent !== true) {
    fail("Az adatkezelési hozzájárulás szükséges.");
  }

  return { name, companyName, email, phone, preferredContact };
}

function parseLogistics(value: unknown): Logistics {
  const source = record(value, "átvétel és időzítés");
  const fulfillment = enumValue<Fulfillment>(
    source.fulfillment,
    fulfillments,
    "átvétel módja",
  );
  const postalCode = fieldText(source.postalCode, "irányítószám", 4);
  if (fulfillment === "delivery" && !/^[1-9]\d{3}$/.test(postalCode)) {
    fail("Szállítás esetén adjon meg érvényes, 4 számjegyű irányítószámot.");
  }
  const targetDate = validDate(source.targetDate, "kívánt időpont");
  if (targetDate && targetDate < budapestToday()) {
    fail("A kívánt időpont nem lehet korábbi a mai napnál.");
  }
  const note = fieldText(source.note, "egyéb megjegyzés", 2000, 0, true);
  return {
    fulfillment,
    postalCode: fulfillment === "delivery" ? postalCode : "",
    targetDate,
    note,
  };
}

function parseManualData(source: Record<string, unknown>) {
  if (!Array.isArray(source.materials) || source.materials.length < 1) {
    fail("Vegyen fel legalább egy anyagot.");
  }
  if (source.materials.length > 50) {
    fail("Legfeljebb 50 különböző anyag adható meg.");
  }

  const materialIds = new Set<string>();
  const materialPairs = new Set<string>();
  const materials = source.materials.map((raw, index): Material => {
    const item = record(raw, `${index + 1}. anyag`);
    const clientId = fieldText(item.clientId, `${index + 1}. anyag azonosítója`, 100, 1);
    if (!/^[A-Za-z0-9_-]+$/.test(clientId) || materialIds.has(clientId)) {
      fail(`A(z) ${index + 1}. anyag azonosítója hibás vagy nem egyedi.`);
    }
    materialIds.add(clientId);

    const name = fieldText(item.name, `${index + 1}. anyag neve`, 120, 2);
    const thicknessMm = numericField(
      item.thicknessMm,
      `${index + 1}. anyag vastagsága`,
      1,
      100,
    );
    const pair = `${name.toLocaleLowerCase("hu-HU")}\u001f${thicknessMm}`;
    if (materialPairs.has(pair)) {
      fail(`A(z) ${index + 1}. anyag neve és vastagsága már szerepel a listában.`);
    }
    materialPairs.add(pair);

    return { clientId, name, thicknessMm, displayOrder: index + 1 };
  });

  if (!Array.isArray(source.items) || source.items.length < 1) {
    fail("Vegyen fel legalább egy szabászjegyzék-tételt.");
  }
  if (source.items.length > 500) {
    fail("Kézi megadásnál legfeljebb 500 tétel küldhető be.");
  }

  let pieces = 0;
  let areaM2 = 0;
  let edgeM = 0;

  const items = source.items.map((raw, index): CuttingItem => {
    const item = record(raw, `${index + 1}. tétel`);
    const materialClientId = fieldText(
      item.materialClientId,
      `${index + 1}. tétel anyaga`,
      100,
      1,
    );
    if (!materialIds.has(materialClientId)) {
      fail(`A(z) ${index + 1}. tételhez válasszon a megadott anyagok közül.`);
    }

    const name = fieldText(item.name, `${index + 1}. tétel elnevezése`, 100);
    const lengthMm = numericField(item.lengthMm, `${index + 1}. tétel hossza`, 10, 5000);
    const widthMm = numericField(item.widthMm, `${index + 1}. tétel szélessége`, 10, 5000);
    const quantity = numericField(
      item.quantity,
      `${index + 1}. tétel mennyisége`,
      1,
      999,
      true,
    );
    const edgeCode = enumValue<string>(
      item.edgeCode,
      edgeCodes,
      `${index + 1}. tétel élzárási kódja`,
    );
    const needsEdgeMaterial = edgeCode !== "0-0";
    const edgeMaterialType = fieldText(
      item.edgeMaterialType,
      `${index + 1}. tétel élzáró típusa`,
      120,
      needsEdgeMaterial ? 2 : 0,
    );
    const note = fieldText(item.note, `${index + 1}. tétel megjegyzése`, 500);

    const [longEdges, shortEdges] = edgeCode.split("-").map(Number);
    pieces += quantity;
    areaM2 += quantity * lengthMm * widthMm / 1_000_000;
    edgeM += quantity * (longEdges * lengthMm + shortEdges * widthMm) / 1000;

    return {
      materialClientId,
      name,
      lengthMm,
      widthMm,
      quantity,
      edgeCode,
      edgeMaterialType: needsEdgeMaterial ? edgeMaterialType : "",
      note,
      displayOrder: index + 1,
    };
  });

  return {
    materials,
    items,
    totals: {
      rows: items.length,
      pieces,
      areaM2: round(areaM2),
      edgeM: round(edgeM),
    },
  };
}

function parsePayload(value: unknown): ValidatedPayload {
  const source = record(value, "ajánlatkérés");
  if (source.schemaVersion !== 1) {
    fail("Az űrlap verziója nem támogatott. Kérjük, frissítse az oldalt.");
  }

  const flow = enumValue<Flow>(source.flow, flows, "beküldési mód");
  const details = record(source.details, "ajánlat részletei");
  const contact = parseContact(source.contact, source.privacyConsent);

  let logistics: Logistics | null = null;
  let materialSource: MaterialSource | null = null;
  let upload: ValidatedPayload["upload"] = null;
  let help: ValidatedPayload["help"] = null;
  let materials: Material[] = [];
  let items: CuttingItem[] = [];
  let totals: Totals = { rows: 0, pieces: 0, areaM2: 0, edgeM: 0 };
  let sizeBasis: "finished" = "finished";

  if (flow === "manual" || flow === "upload") {
    if (details.sizeBasis !== "finished") {
      fail("A méreteket kész méretként, élzárással együtt kell megadni.");
    }
    materialSource = enumValue<MaterialSource>(
      details.materialSource,
      materialSources,
      "anyag forrása",
    );
    logistics = parseLogistics(source.logistics);
  } else if (source.logistics !== null && source.logistics !== undefined) {
    fail("Segítségkérésnél nem adható meg logisztikai adat.");
  }

  if (flow === "manual") {
    const manual = parseManualData(details);
    materials = manual.materials;
    items = manual.items;
    totals = manual.totals;
  }

  if (flow === "upload") {
    upload = {
      material: fieldText(details.materialHint, "anyag, dekor vagy lapfajta", 120),
      thicknessMm: optionalNumber(details.thicknessMm, "lapvastagság", 1, 100),
      note: fieldText(details.note, "fájl megjegyzése", 500, 0, true),
    };
  }

  if (flow === "help") {
    if (!Array.isArray(details.topics) || details.topics.length < 1) {
      fail("Válasszon legalább egy témát a segítségkéréshez.");
    }
    const topics = details.topics.map((topic) =>
      enumValue<string>(topic, helpTopics, "segítségkérés témája")
    );
    if (new Set(topics).size !== topics.length) {
      fail("Egy segítségkérési téma csak egyszer szerepelhet.");
    }
    help = {
      topics,
      description: fieldText(
        details.description,
        "segítségkérés leírása",
        5000,
        20,
        true,
      ),
    };
  }

  return {
    schemaVersion: 1,
    flow,
    sizeBasis,
    contact,
    logistics,
    materialSource,
    upload,
    help,
    materials,
    items,
    totals,
  };
}

function cleanOriginalName(value: string, fallback: string) {
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 255);
  return cleaned || fallback;
}

function startsWithBytes(bytes: Uint8Array, expected: number[], offset = 0) {
  return expected.every((value, index) => bytes[offset + index] === value);
}

function extensionOf(name: string): FileFormat | null {
  const extension = name.split(".").pop()?.toLowerCase();
  if (extension === "jpeg") return "jpg";
  if (
    extension === "jpg" ||
    extension === "png" ||
    extension === "pdf" ||
    extension === "xlsx" ||
    extension === "csv"
  ) {
    return extension;
  }
  return null;
}

function canonicalContentType(extension: FileFormat) {
  const types: Record<FileFormat, string> = {
    jpg: "image/jpeg",
    png: "image/png",
    pdf: "application/pdf",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    csv: "text/csv",
  };
  return types[extension];
}

function compatibleMimeTypes(extension: FileFormat) {
  const types: Record<FileFormat, Set<string>> = {
    jpg: new Set(["image/jpeg", "image/jpg"]),
    png: new Set(["image/png"]),
    pdf: new Set(["application/pdf"]),
    xlsx: new Set([
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/zip",
      "application/x-zip-compressed",
    ]),
    csv: new Set([
      "text/csv",
      "application/csv",
      "text/plain",
      "application/vnd.ms-excel",
    ]),
  };
  return types[extension];
}

function hasTextLikeSignature(bytes: Uint8Array) {
  let controls = 0;
  for (const byte of bytes) {
    if (byte === 0) return false;
    if (byte < 9 || (byte > 13 && byte < 32) || byte === 127) controls += 1;
  }
  if (controls > Math.max(2, Math.floor(bytes.length * 0.01))) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function containsAscii(bytes: Uint8Array, value: string) {
  const needle = new TextEncoder().encode(value);
  outer:
  for (let start = 0; start <= bytes.length - needle.length; start += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (bytes[start + offset] !== needle[offset]) continue outer;
    }
    return true;
  }
  return false;
}

async function sha256Bytes(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function validateFile(file: File, flow: Flow): Promise<ValidatedFile> {
  if (file.size < 1) fail(`${file.name || "A kiválasztott fájl"} üres.`);
  if (file.size > MAX_FILE_BYTES) {
    fail(`${file.name || "A kiválasztott fájl"} nagyobb 6 MB-nál.`);
  }

  const extension = extensionOf(file.name);
  if (!extension) {
    fail(`${file.name || "A kiválasztott fájl"} formátuma nem támogatott.`);
  }

  const allowedForFlow = flow === "help"
    ? new Set<FileFormat>(["jpg", "png", "pdf"])
    : new Set<FileFormat>(["jpg", "png", "pdf", "xlsx", "csv"]);
  if (!allowedForFlow.has(extension)) {
    fail(`${file.name} formátuma ennél a beküldési módnál nem támogatott.`);
  }

  const claimedType = file.type.toLowerCase().split(";")[0].trim();
  const genericMime = claimedType === "" || claimedType === "application/octet-stream";
  if (!genericMime && !compatibleMimeTypes(extension).has(claimedType)) {
    fail(`${file.name} fájltípusa és kiterjesztése nem egyezik.`);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  let signatureValid = false;

  switch (extension) {
    case "jpg":
      signatureValid = startsWithBytes(bytes, [0xff, 0xd8, 0xff]);
      break;
    case "png":
      signatureValid = startsWithBytes(
        bytes,
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      );
      break;
    case "pdf":
      signatureValid = startsWithBytes(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]);
      break;
    case "xlsx":
      signatureValid =
        startsWithBytes(bytes, [0x50, 0x4b, 0x03, 0x04]) &&
        containsAscii(bytes, "[Content_Types].xml") &&
        containsAscii(bytes, "xl/workbook.xml");
      break;
    case "csv":
      signatureValid = hasTextLikeSignature(bytes);
      break;
  }

  if (!signatureValid) {
    fail(`${file.name} tartalma nem felel meg a fájlformátumának.`);
  }

  return {
    file,
    extension,
    contentType: canonicalContentType(extension),
    originalName: cleanOriginalName(file.name, `feltoltes.${extension}`),
    contentHash: await sha256Bytes(bytes),
  };
}

async function parseFiles(formData: FormData, flow: Flow) {
  const entries = formData.getAll("attachments");
  if (entries.some((entry) => !(entry instanceof File))) {
    fail("Az egyik csatolmány nem olvasható.");
  }
  const files = entries as File[];

  if (files.length > MAX_FILES) {
    fail(`Legfeljebb ${MAX_FILES} fájl tölthető fel.`);
  }
  if (flow === "manual" && files.length > 0) {
    fail("Kézi tételmegadásnál ezen az űrlapon nem küldhető csatolmány.");
  }
  if (flow === "upload" && files.length < 1) {
    fail("Töltsön fel legalább egy szabászjegyzéket.");
  }

  const totalSize = files.reduce((sum, file) => sum + file.size, 0);
  if (totalSize > MAX_TOTAL_FILE_BYTES) {
    fail("A csatolmányok összmérete legfeljebb 15 MB lehet.");
  }

  const validated: ValidatedFile[] = [];
  for (const file of files) validated.push(await validateFile(file, flow));
  return validated;
}

function trimMessage(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  const suffix = "\n[… további részletek a lapszabászati adatlapon]";
  return `${value.slice(0, maxLength - suffix.length).trimEnd()}${suffix}`;
}

function buildSummary(
  payload: ValidatedPayload,
  files: ValidatedFile[],
  isPreview: boolean,
) {
  const lines: string[] = [];
  if (isPreview) lines.push("[FEJLESZTÉSI PRÓBA – NEM ÉLES MEGRENDELÉS]", "");
  lines.push(
    "LAPSZABÁSZATI AJÁNLATKÉRÉS",
    `Beküldési mód: ${flowLabels[payload.flow]}`,
    "Méretértelmezés: kész méret, élzárással együtt",
  );

  if (payload.contact.companyName) {
    lines.push(`Cégnév: ${payload.contact.companyName}`);
  }

  if (payload.flow === "manual") {
    lines.push(
      `Anyag biztosítása: ${materialSourceLabels[payload.materialSource!]}`,
      `Összesítés: ${payload.totals.rows} tétel, ${payload.totals.pieces} darab, ${payload.totals.areaM2.toFixed(2)} m², kb. ${payload.totals.edgeM.toFixed(1)} fm él`,
      "",
      "Anyagok:",
      ...payload.materials.map((material, index) =>
        `${index + 1}. ${material.name} – ${material.thicknessMm} mm`
      ),
      "",
      "Tételek:",
      ...payload.items.map((item, index) => {
        const material = payload.materials.find(
          (candidate) => candidate.clientId === item.materialClientId,
        );
        const edge = item.edgeCode === "0-0"
          ? "0-0, élzárás nélkül"
          : `${item.edgeCode} (${edgeCodeLabels[item.edgeCode]}); ${item.edgeMaterialType}`;
        return `${index + 1}. ${item.name || "Névtelen tétel"} – ${material?.name || "ismeretlen anyag"}, ${item.lengthMm} × ${item.widthMm} mm, ${item.quantity} db; él: ${edge}${item.note ? `; megjegyzés: ${item.note}` : ""}`;
      }),
    );
  }

  if (payload.flow === "upload") {
    const thickness = payload.upload!.thicknessMm === null
      ? "egyeztetendő"
      : `${payload.upload!.thicknessMm} mm`;
    lines.push(
      `Anyag biztosítása: ${materialSourceLabels[payload.materialSource!]}`,
      `Anyag / dekor: ${payload.upload!.material || "egyeztetendő"}`,
      `Lapvastagság: ${thickness}`,
      `Feltöltött fájlok: ${files.length} db`,
      ...files.map((file, index) => `${index + 1}. ${file.originalName}`),
    );
    if (payload.upload!.note) lines.push(`Megjegyzés a fájlhoz: ${payload.upload!.note}`);
  }

  if (payload.flow === "help") {
    lines.push(
      `Témák: ${payload.help!.topics.map((topic) => helpTopicLabels[topic as keyof typeof helpTopicLabels]).join(", ")}`,
      "",
      "Leírás:",
      payload.help!.description,
      `Csatolmányok: ${files.length} db`,
    );
    if (files.length) {
      lines.push(...files.map((file, index) => `${index + 1}. ${file.originalName}`));
    }
  }

  if (payload.logistics) {
    lines.push(
      "",
      `Átvétel: ${fulfillmentLabels[payload.logistics.fulfillment]}`,
    );
    if (payload.logistics.postalCode) {
      lines.push(`Szállítási irányítószám: ${payload.logistics.postalCode}`);
    }
    if (payload.logistics.targetDate) {
      lines.push(`Kívánt időpont: ${payload.logistics.targetDate}`);
    }
    if (payload.logistics.note) {
      lines.push(`Egyéb megjegyzés: ${payload.logistics.note}`);
    }
  }

  return trimMessage(lines.join("\n"), 5000);
}

function approximateDimensions(payload: ValidatedPayload, files: ValidatedFile[]) {
  if (payload.flow === "manual") {
    return `${payload.totals.rows} tétel · ${payload.totals.pieces} db · ${payload.totals.areaM2.toFixed(2)} m² · kb. ${payload.totals.edgeM.toFixed(1)} fm él`;
  }
  if (payload.flow === "upload") {
    return `Feltöltött szabászjegyzék · ${files.length} fájl`;
  }
  return "Lapszabászati segítségkérés";
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
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  };

  if (origin && allowedOrigins.has(origin)) {
    headers["access-control-allow-origin"] = origin;
    headers.vary = "Origin";
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function errorResponse(
  code: string,
  message: string,
  status: number,
  origin?: string,
  extraHeaders: Record<string, string> = {},
) {
  return json({ ok: false, code, error: message }, status, origin, extraHeaders);
}

function referenceFor(id: string | number) {
  return `HEPA-LSZ-${String(id).padStart(6, "0")}`;
}

function success(
  id: string | number,
  origin: string,
  status = 201,
) {
  return json({
    ok: true,
    message: "Köszönjük az ajánlatkérést! Hamarosan felvesszük Önnel a kapcsolatot.",
    reference: referenceFor(id),
  }, status, origin);
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
    `cutting-quote-rate-limit-v1\n${day}\n${address}`,
  );

  const { data, error } = await supabase.rpc("consume_quote_submission_limit", {
    p_fingerprint_hash: fingerprint,
    p_max_attempts: 5,
    p_window_seconds: 600,
  });

  if (error) {
    console.error("cutting quote rate limit check failed", error.code);
    throw new Error("rate-limit-unavailable");
  }
  return data !== true;
}

function rpcRow(value: unknown) {
  const row = Array.isArray(value) ? value[0] : value;
  return isRecord(row) ? row : null;
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function rpcArguments(
  payload: ValidatedPayload,
  files: ValidatedFile[],
  submissionToken: string,
  summary: string,
  payloadHash: string,
  isPreview: boolean,
) {
  return {
    p_request: {
      submissionToken,
      flow: payload.flow,
      contact: {
        name: payload.contact.name,
        companyName: payload.contact.companyName || null,
        email: payload.contact.email || null,
        phone: payload.contact.phone || null,
        preferredContact: payload.contact.preferredContact,
      },
      details: {
        materialSource: payload.materialSource,
        sizeBasis: payload.flow === "help" ? null : payload.sizeBasis,
        materialHint: payload.upload?.material || null,
        thicknessMm: payload.upload?.thicknessMm ?? null,
        topics: payload.help?.topics || [],
        description: payload.help?.description || null,
        materials: payload.materials.map((material) => ({
          position: material.displayOrder,
          client_id: material.clientId,
          name: material.name,
          thickness_mm: material.thicknessMm,
        })),
        items: payload.items.map((item) => ({
          position: item.displayOrder,
          material_client_id: item.materialClientId,
          label: item.name || null,
          length_mm: item.lengthMm,
          width_mm: item.widthMm,
          quantity: item.quantity,
          edge_code: item.edgeCode,
          edge_material_type: item.edgeMaterialType || null,
          note: item.note || null,
        })),
      },
      logistics: payload.logistics
        ? {
          fulfillment: payload.logistics.fulfillment,
          postalCode: payload.logistics.postalCode || null,
          targetDate: payload.logistics.targetDate || null,
          note: payload.logistics.note || null,
        }
        : null,
      message: summary,
      approximateDimensions: approximateDimensions(payload, files),
      payloadHash,
      isTest: isPreview,
    },
  };
}

async function markReconciliation(
  supabase: SupabaseClient,
  quoteRequestId: number,
  reason: string,
) {
  const { error } = await supabase.rpc("mark_cutting_quote_reconciliation", {
    p_quote_request_id: quoteRequestId,
    p_reason: reason.slice(0, 200),
  });
  if (error) {
    console.error("cutting quote reconciliation marker failed", error.code);
  }
}

async function readCuttingState(
  supabase: SupabaseClient,
  quoteRequestId: number,
) {
  const { data, error } = await supabase
    .from("cutting_quote_requests")
    .select("submission_state")
    .eq("quote_request_id", quoteRequestId)
    .maybeSingle();

  if (error) {
    console.error("cutting quote state read-back failed", error.code);
    return null;
  }
  return typeof data?.submission_state === "string"
    ? data.submission_state
    : null;
}

async function ensureFinalized(
  supabase: SupabaseClient,
  quoteRequestId: number,
  fileRows: Array<Record<string, unknown>>,
) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { data, error } = await supabase.rpc(
      "finalize_cutting_quote_request",
      {
        p_quote_request_id: quoteRequestId,
        p_files: fileRows,
      },
    );
    const row = rpcRow(data);
    if (!error && row?.state === "ready") return true;

    console.error("cutting quote finalize RPC failed", error?.code || "invalid-state");
    const state = await readCuttingState(supabase, quoteRequestId);
    if (state === "ready") return true;
    if (state !== "ingesting") return false;
  }

  return false;
}

function notificationRecipients() {
  const configured = Deno.env.get("QUOTE_NOTIFICATION_TO") || "hepaconstructkft@gmail.com";
  const addresses = configured
    .split(",")
    .map((address) => address.trim())
    .filter((address) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address));
  return addresses.length ? addresses : ["hepaconstructkft@gmail.com"];
}

async function sendNotification(details: {
  quoteRequestId: number;
  payload: ValidatedPayload;
  files: ValidatedFile[];
  summary: string;
  isPreview: boolean;
}) {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) {
    return {
      sent: false,
      error: "resend-api-key-missing",
      providerMessageId: null,
    };
  }

  const contact = details.payload.contact;
  const body = trimMessage([
    details.isPreview
      ? "FEJLESZTÉSI PRÓBA – új lapszabászati teszt-ajánlatkérés érkezett."
      : "Új lapszabászati ajánlatkérés érkezett a weboldalról.",
    "",
    `Azonosító: ${referenceFor(details.quoteRequestId)}`,
    `Név: ${contact.name}`,
    `Cégnév: ${contact.companyName || "nincs megadva"}`,
    `Telefonszám: ${contact.phone || "nincs megadva"}`,
    `E-mail: ${contact.email || "nincs megadva"}`,
    `Elsődleges kapcsolattartás: ${contact.preferredContact === "phone" ? "telefon" : "e-mail"}`,
    "",
    details.summary,
  ].join("\n"), 20_000);

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        "idempotency-key": `hepa-cutting-new-${details.quoteRequestId}`,
      },
      body: JSON.stringify({
        from: Deno.env.get("QUOTE_NOTIFICATION_FROM") ||
          "HEPA ajánlatkérő <onboarding@resend.dev>",
        to: notificationRecipients(),
        subject: details.isPreview
          ? `[TESZT] Lapszabászati ajánlatkérés – ${referenceFor(details.quoteRequestId)}`
          : `Új lapszabászati ajánlatkérés – ${referenceFor(details.quoteRequestId)}`,
        text: body,
        ...(contact.email ? { reply_to: contact.email } : {}),
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) {
      return {
        sent: false,
        error: `resend-http-${response.status}`,
        providerMessageId: null,
      };
    }

    const responseBody = await response.json().catch(() => null);
    const providerMessageId = isRecord(responseBody) &&
        typeof responseBody.id === "string"
      ? responseBody.id.trim()
      : "";

    if (!providerMessageId) {
      return {
        sent: false,
        error: "resend-response-missing-id",
        providerMessageId: null,
      };
    }

    return { sent: true, error: null, providerMessageId };
  } catch (error) {
    return {
      sent: false,
      error: error instanceof DOMException && error.name === "TimeoutError"
        ? "resend-timeout"
        : "resend-request-failed",
      providerMessageId: null,
    };
  }
}

async function processNotification(
  supabase: SupabaseClient,
  details: {
    quoteRequestId: number;
    payload: ValidatedPayload;
    files: ValidatedFile[];
    summary: string;
    isPreview: boolean;
  },
) {
  const { data: claimData, error: claimError } = await supabase.rpc(
    "claim_cutting_quote_notification",
    { p_quote_request_id: details.quoteRequestId },
  );
  if (claimError) {
    console.error("cutting quote notification claim failed", claimError.code);
    return;
  }

  const claim = rpcRow(claimData);
  if (claim?.state !== "send") return;

  const notification = await sendNotification(details);
  const { error: completionError } = await supabase.rpc(
    "complete_cutting_quote_notification",
    {
      p_quote_request_id: details.quoteRequestId,
      p_sent: notification.sent,
      p_provider_message_id: notification.providerMessageId,
      p_error: notification.error,
    },
  );
  if (completionError) {
    console.error("cutting quote notification completion failed", completionError.code);
  }
}

async function handleRequest(request: Request) {
  const origin = request.headers.get("origin") ?? "";

  if (!allowedOrigins.has(origin)) {
    return errorResponse(
      "origin-not-allowed",
      "Ez a weboldal nem küldhet ajánlatkérést.",
      403,
    );
  }

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "86400",
        vary: "Origin",
      },
    });
  }

  if (request.method !== "POST") {
    return errorResponse("method-not-allowed", "Nem támogatott kérés.", 405, origin);
  }

  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
    return errorResponse(
      "unsupported-media-type",
      "Az űrlapot multipart formátumban kell elküldeni.",
      415,
      origin,
    );
  }

  const contentLengthHeader = request.headers.get("content-length");
  if (!contentLengthHeader || !/^\d+$/.test(contentLengthHeader)) {
    return errorResponse(
      "length-required",
      "A feltöltés mérete nem ellenőrizhető. Kérjük, próbálja újra friss böngészőből.",
      411,
      origin,
    );
  }
  const contentLength = Number(contentLengthHeader);
  if (!Number.isSafeInteger(contentLength) || contentLength < 1) {
    return errorResponse(
      "invalid-content-length",
      "A feltöltés mérete hibás.",
      400,
      origin,
    );
  }
  if (contentLength > MAX_REQUEST_BYTES) {
    return errorResponse(
      "request-too-large",
      "A feltöltés összmérete túl nagy.",
      413,
      origin,
    );
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const secretKey = serviceRoleKey();
  if (!supabaseUrl || !secretKey) {
    return errorResponse(
      "service-unavailable",
      "A szolgáltatás átmenetileg nem érhető el.",
      503,
      origin,
    );
  }

  const supabase = createClient(supabaseUrl, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    if (await rateLimitExceeded(supabase, request, secretKey)) {
      return errorResponse(
        "rate-limit-exceeded",
        "Túl sok próbálkozás érkezett. Kérjük, próbálja újra 10 perc múlva.",
        429,
        origin,
        { "retry-after": "600" },
      );
    }
  } catch {
    return errorResponse(
      "rate-limit-unavailable",
      "A szolgáltatás átmenetileg nem érhető el.",
      503,
      origin,
    );
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return errorResponse("invalid-form", "Az űrlap nem olvasható.", 400, origin);
  }

  const honeypot = formData.get("company_website");
  if (typeof honeypot === "string" && honeypot.trim()) {
    return json({ ok: true }, 200, origin);
  }

  const submissionTokenValue = formData.get("submission_token");
  const submissionToken = typeof submissionTokenValue === "string"
    ? submissionTokenValue.trim()
    : "";
  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidPattern.test(submissionToken)) {
    return errorResponse(
      "invalid-submission-token",
      "Az ajánlatkérés azonosítója hibás. Kérjük, frissítse az oldalt.",
      400,
      origin,
    );
  }

  const rawPayload = formData.get("payload");
  if (typeof rawPayload !== "string") {
    return errorResponse(
      "payload-missing",
      "Az ajánlatkérés adatai hiányoznak.",
      400,
      origin,
    );
  }
  if (new TextEncoder().encode(rawPayload).byteLength > MAX_PAYLOAD_BYTES) {
    return errorResponse(
      "payload-too-large",
      "Az ajánlatkérés túl sok adatot tartalmaz.",
      413,
      origin,
    );
  }

  let payload: ValidatedPayload;
  let files: ValidatedFile[];
  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawPayload);
    } catch {
      fail("Az ajánlatkérés adatai nem olvashatók.");
    }
    payload = parsePayload(parsed);
    files = await parseFiles(formData, payload.flow);
  } catch (error) {
    if (error instanceof InputError) {
      return errorResponse("validation-failed", error.message, 400, origin);
    }
    throw error;
  }

  const isPreview = previewOrigins.has(origin);
  const summary = buildSummary(payload, files, isPreview);
  const payloadHash = await sha256(JSON.stringify({
    payload: rawPayload,
    files: files.map((file) => ({
      name: file.originalName,
      size: file.file.size,
      contentType: file.contentType,
      sha256: file.contentHash,
    })),
  }));
  const { data: createdData, error: createError } = await supabase.rpc(
    "create_cutting_quote_request",
    rpcArguments(payload, files, submissionToken, summary, payloadHash, isPreview),
  );

  if (createError) {
    console.error("create cutting quote RPC failed", createError.code);
    return errorResponse(
      "save-failed",
      "Az ajánlatkérés mentése nem sikerült.",
      500,
      origin,
    );
  }

  const createdRow = rpcRow(createdData);
  const quoteRequestId = Number(createdRow?.quote_id);
  const ingestState = createdRow?.state;
  const isDuplicate = createdRow?.duplicate === true;

  if (!Number.isSafeInteger(quoteRequestId) || quoteRequestId < 1) {
    console.error("create cutting quote RPC returned an invalid id");
    return errorResponse(
      "save-failed",
      "Az ajánlatkérés mentése nem sikerült.",
      500,
      origin,
    );
  }

  if (isDuplicate && ingestState === "conflict") {
    return errorResponse(
      "submission-token-conflict",
      "A korábbi küldési próbálkozás óta megváltoztak az adatok. Kérjük, frissítse az oldalt, és küldje el újra.",
      409,
      origin,
    );
  }

  if (isDuplicate && ingestState === "ready") {
    await processNotification(supabase, {
      quoteRequestId,
      payload,
      files,
      summary,
      isPreview,
    });
    return json({
      ok: true,
      duplicate: true,
      message: "Ezt az ajánlatkérést már rögzítettük.",
      reference: referenceFor(quoteRequestId),
    }, 200, origin);
  }

  if (ingestState !== "ingesting") {
    console.error("create cutting quote RPC returned an invalid state");
    return errorResponse(
      "save-failed",
      "Az ajánlatkérés mentése nem sikerült. Kérjük, próbálja újra.",
      500,
      origin,
    );
  }

  const fileRows: Array<Record<string, unknown>> = [];
  const filePurpose = payload.flow === "upload"
    ? "cutting_list"
    : "help_attachment";

  for (const [fileIndex, validatedFile] of files.entries()) {
    const storagePath =
      `cutting/${quoteRequestId}/${String(fileIndex + 1).padStart(2, "0")}-${validatedFile.contentHash.slice(0, 24)}.${validatedFile.extension}`;
    const { error: uploadError } = await supabase.storage
      .from("quote-request-files")
      .upload(storagePath, validatedFile.file, {
        contentType: validatedFile.contentType,
        upsert: true,
      });

    if (uploadError) {
      console.error("cutting quote file upload failed", uploadError.message);
      await markReconciliation(supabase, quoteRequestId, "file-upload-failed");
      return errorResponse(
        "file-upload-failed",
        "A fájl feltöltése most nem sikerült. Az adatok megmaradtak; kérjük, próbálja újra.",
        503,
        origin,
        { "retry-after": "3" },
      );
    }

    fileRows.push({
      storage_path: storagePath,
      original_name: validatedFile.originalName,
      content_type: validatedFile.contentType,
      size_bytes: validatedFile.file.size,
      file_purpose: filePurpose,
      content_sha256: validatedFile.contentHash,
    });
  }

  if (!await ensureFinalized(supabase, quoteRequestId, fileRows)) {
    await markReconciliation(supabase, quoteRequestId, "finalize-unconfirmed");
    return errorResponse(
      "finalize-unconfirmed",
      "Az ajánlatkérés véglegesítése még nem igazolható. Az adatok megmaradtak; kérjük, próbálja újra.",
      503,
      origin,
      { "retry-after": "3" },
    );
  }

  await processNotification(supabase, {
    quoteRequestId,
    payload,
    files,
    summary,
    isPreview,
  });

  return success(quoteRequestId, origin);
}
Deno.serve(async (request) => {
  try {
    return await handleRequest(request);
  } catch (error) {
    console.error(
      "unexpected cutting quote submission error",
      error instanceof Error ? error.name : "unknown",
    );
    const origin = request.headers.get("origin") ?? "";
    return errorResponse(
      "unexpected-error",
      "A szolgáltatás átmenetileg nem érhető el.",
      500,
      origin,
    );
  }
});
