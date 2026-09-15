import { createClient } from "npm:@supabase/supabase-js@2.115.0";

const MAX_REQUEST_BYTES = 55 * 1024 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_FILE_BYTES = 50 * 1024 * 1024;
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
  customerName: string;
  companyName: string;
  email: string;
  phone: string;
  preferredContact: PreferredContact;
};

type Logistics = {
  fulfillment: Fulfillment;
  postalCode: string;
  targetDate: string;
  projectNote: string;
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

type FileFormat = "jpg" | "png" | "pdf" | "xlsx" | "xls" | "csv";

type ValidatedFile = {
  file: File;
  extension: FileFormat;
  contentType: string;
  originalName: string;
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

function parseContact(value: unknown): Contact {
  const source = record(value, "kapcsolattartás");
  const customerName = fieldText(source.customerName, "név", 100, 2);
  const companyName = fieldText(source.companyName, "cégnév", 100);
  const email = fieldText(source.email, "e-mail-cím", 254).toLowerCase();
  const phone = fieldText(source.phone, "telefonszám", 40);

  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    fail("Kérjük, adjon meg érvényes e-mail-címet.");
  }

  const phoneDigits = phone.replace(/\D/g, "");
  if (phone && (phoneDigits.length < 7 || phoneDigits.length > 15)) {
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
  if (source.consent !== true) {
    fail("Az adatkezelési hozzájárulás szükséges.");
  }

  return { customerName, companyName, email, phone, preferredContact };
}

function parseLogistics(value: unknown): Logistics {
  const source = record(value, "átvétel és időzítés");
  const fulfillment = enumValue<Fulfillment>(
    source.fulfillment,
    fulfillments,
    "átvétel módja",
  );
  const postalCode = fieldText(source.postalCode, "irányítószám", 4);
  if (fulfillment === "delivery" && !/^\d{4}$/.test(postalCode)) {
    fail("Szállítás esetén adjon meg 4 számjegyű irányítószámot.");
  }
  const targetDate = validDate(source.targetDate, "kívánt időpont");
  if (targetDate && targetDate < budapestToday()) {
    fail("A kívánt időpont nem lehet korábbi a mai napnál.");
  }
  const projectNote = fieldText(source.projectNote, "egyéb megjegyzés", 1000, 0, true);
  return {
    fulfillment,
    postalCode: fulfillment === "delivery" ? postalCode : "",
    targetDate,
    projectNote,
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
    const clientId = fieldText(item.id, `${index + 1}. anyag azonosítója`, 80, 1);
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
      item.materialId,
      `${index + 1}. tétel anyaga`,
      80,
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
  if (source.sizeBasis !== "finished") {
    fail("A méreteket kész méretként, élzárással együtt kell megadni.");
  }

  const contact = parseContact(source.contact);
  let logistics: Logistics | null = null;
  let materialSource: MaterialSource | null = null;
  let upload: ValidatedPayload["upload"] = null;
  let help: ValidatedPayload["help"] = null;
  let materials: Material[] = [];
  let items: CuttingItem[] = [];
  let totals: Totals = { rows: 0, pieces: 0, areaM2: 0, edgeM: 0 };

  if (flow === "manual" || flow === "upload") {
    materialSource = enumValue<MaterialSource>(
      source.materialSource,
      materialSources,
      "anyag forrása",
    );
    logistics = parseLogistics(source.logistics);
  }

  if (flow === "manual") {
    const manual = parseManualData(source);
    materials = manual.materials;
    items = manual.items;
    totals = manual.totals;
  }

  if (flow === "upload") {
    const uploadSource = record(source.upload, "feltöltött szabászjegyzék");
    upload = {
      material: fieldText(uploadSource.material, "anyag, dekor vagy lapfajta", 120),
      thicknessMm: optionalNumber(uploadSource.thicknessMm, "lapvastagság", 1, 100),
      note: fieldText(uploadSource.note, "fájl megjegyzése", 500, 0, true),
    };
  }

  if (flow === "help") {
    const helpSource = record(source.help, "segítségkérés");
    if (!Array.isArray(helpSource.topics) || helpSource.topics.length < 1) {
      fail("Válasszon legalább egy témát a segítségkéréshez.");
    }
    const topics = helpSource.topics.map((topic) =>
      enumValue<string>(topic, helpTopics, "segítségkérés témája")
    );
    if (new Set(topics).size !== topics.length) {
      fail("Egy segítségkérési téma csak egyszer szerepelhet.");
    }
    help = {
      topics,
      description: fieldText(
        helpSource.description,
        "segítségkérés leírása",
        1500,
        20,
        true,
      ),
    };
  }

  return {
    schemaVersion: 1,
    flow,
    sizeBasis: "finished",
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
    extension === "xls" ||
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
    xls: "application/vnd.ms-excel",
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
    xls: new Set([
      "application/vnd.ms-excel",
      "application/x-ole-storage",
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
  return controls <= Math.max(2, Math.floor(bytes.length * 0.01));
}

async function validateFile(file: File, flow: Flow): Promise<ValidatedFile> {
  if (file.size < 1) fail(`${file.name || "A kiválasztott fájl"} üres.`);
  if (file.size > MAX_FILE_BYTES) {
    fail(`${file.name || "A kiválasztott fájl"} nagyobb 10 MB-nál.`);
  }

  const extension = extensionOf(file.name);
  if (!extension) {
    fail(`${file.name || "A kiválasztott fájl"} formátuma nem támogatott.`);
  }

  const allowedForFlow = flow === "help"
    ? new Set<FileFormat>(["jpg", "png", "pdf"])
    : new Set<FileFormat>(["jpg", "png", "pdf", "xlsx", "xls", "csv"]);
  if (!allowedForFlow.has(extension)) {
    fail(`${file.name} formátuma ennél a beküldési módnál nem támogatott.`);
  }

  const claimedType = file.type.toLowerCase().split(";")[0].trim();
  const genericMime = claimedType === "" || claimedType === "application/octet-stream";
  if (!genericMime && !compatibleMimeTypes(extension).has(claimedType)) {
    fail(`${file.name} fájltípusa és kiterjesztése nem egyezik.`);
  }

  const sampleSize = extension === "csv" ? Math.min(file.size, 64 * 1024) : 16;
  const bytes = new Uint8Array(await file.slice(0, sampleSize).arrayBuffer());
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
      signatureValid = startsWithBytes(bytes, [0x50, 0x4b, 0x03, 0x04]);
      break;
    case "xls":
      signatureValid = startsWithBytes(
        bytes,
        [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
      );
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
    fail("A csatolmányok összmérete legfeljebb 50 MB lehet.");
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
    if (payload.logistics.projectNote) {
      lines.push(`Egyéb megjegyzés: ${payload.logistics.projectNote}`);
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

function rpcArguments(
  payload: ValidatedPayload,
  files: ValidatedFile[],
  submissionToken: string,
  summary: string,
  isPreview: boolean,
) {
  return {
    p_submission_token: submissionToken,
    p_parent: {
      customer_name: payload.contact.customerName,
      email: payload.contact.email || null,
      phone: payload.contact.phone || null,
      project_type: "other",
      postcode: payload.logistics?.postalCode || null,
      preferred_contact: payload.contact.preferredContact,
      message: summary,
      consent: true,
      source: "website",
      approximate_dimensions: approximateDimensions(payload, files),
      wants_callback: payload.contact.preferredContact === "phone",
      wants_quote: payload.flow !== "help",
      wants_consultation: payload.flow === "help",
    },
    p_cutting: {
      schema_version: payload.schemaVersion,
      flow: payload.flow,
      size_basis: payload.sizeBasis,
      state: "ingesting",
      material_source: payload.materialSource,
      fulfillment: payload.logistics?.fulfillment || null,
      postal_code: payload.logistics?.postalCode || null,
      target_date: payload.logistics?.targetDate || null,
      company_name: payload.contact.companyName || null,
      project_note: payload.logistics?.projectNote || null,
      upload_material: payload.upload?.material || null,
      upload_thickness_mm: payload.upload?.thicknessMm ?? null,
      upload_note: payload.upload?.note || null,
      help_topics: payload.help?.topics || [],
      help_description: payload.help?.description || null,
      total_rows: payload.totals.rows,
      total_pieces: payload.totals.pieces,
      total_area_m2: payload.totals.areaM2,
      total_edge_m: payload.totals.edgeM,
      file_count: files.length,
      is_test: isPreview,
    },
    p_materials: payload.materials.map((material) => ({
      client_id: material.clientId,
      name: material.name,
      thickness_mm: material.thicknessMm,
      display_order: material.displayOrder,
    })),
    p_items: payload.items.map((item) => ({
      material_client_id: item.materialClientId,
      name: item.name || null,
      length_mm: item.lengthMm,
      width_mm: item.widthMm,
      quantity: item.quantity,
      edge_code: item.edgeCode,
      edge_material_type: item.edgeMaterialType || null,
      note: item.note || null,
      display_order: item.displayOrder,
    })),
  };
}

async function markFailed(supabase: SupabaseClient, quoteRequestId: number) {
  const { error } = await supabase
    .from("cutting_quote_requests")
    .update({ state: "failed" })
    .eq("quote_request_id", quoteRequestId)
    .eq("state", "ingesting");
  if (error) console.error("cutting quote failed-state update failed", error.code);
}

async function cleanupUploadedFiles(
  supabase: SupabaseClient,
  quoteRequestId: number,
  paths: string[],
) {
  if (!paths.length) return;

  const { error: metadataError } = await supabase
    .from("quote_request_files")
    .delete()
    .eq("quote_request_id", quoteRequestId)
    .in("storage_path", paths);
  if (metadataError) {
    console.error("cutting quote file metadata cleanup failed", metadataError.code);
  }

  const { error: storageError } = await supabase.storage
    .from("quote-request-files")
    .remove(paths);
  if (storageError) {
    console.error("cutting quote storage cleanup failed", storageError.message);
  }
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
  if (!apiKey) return { sent: false, error: "resend-api-key-missing" };

  const contact = details.payload.contact;
  const body = trimMessage([
    details.isPreview
      ? "FEJLESZTÉSI PRÓBA – új lapszabászati teszt-ajánlatkérés érkezett."
      : "Új lapszabászati ajánlatkérés érkezett a weboldalról.",
    "",
    `Azonosító: ${referenceFor(details.quoteRequestId)}`,
    `Név: ${contact.customerName}`,
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

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
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
  const { data: createdData, error: createError } = await supabase.rpc(
    "create_cutting_quote_request",
    rpcArguments(payload, files, submissionToken, summary, isPreview),
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
  const quoteRequestId = Number(createdRow?.quote_request_id);
  const ingestState = createdRow?.state;
  const wasCreated = createdRow?.created === true;

  if (!Number.isSafeInteger(quoteRequestId) || quoteRequestId < 1) {
    console.error("create cutting quote RPC returned an invalid id");
    return errorResponse(
      "save-failed",
      "Az ajánlatkérés mentése nem sikerült.",
      500,
      origin,
    );
  }

  if (!wasCreated && ingestState === "ready") {
    return success(quoteRequestId, origin, 200);
  }
  if (!wasCreated && ingestState === "ingesting") {
    return errorResponse(
      "submission-in-progress",
      "Az ajánlatkérés feldolgozása már folyamatban van. Kérjük, próbálja újra néhány másodperc múlva.",
      409,
      origin,
      { "retry-after": "3" },
    );
  }
  if (!wasCreated || ingestState !== "ingesting") {
    console.error("create cutting quote RPC returned an invalid state");
    return errorResponse(
      "save-failed",
      "Az ajánlatkérés mentése nem sikerült. Kérjük, próbálja újra.",
      500,
      origin,
    );
  }

  const uploadedPaths: string[] = [];
  const fileRows: Array<Record<string, unknown>> = [];
  const filePurpose = payload.flow === "upload"
    ? "cutting_list"
    : "supporting_document";

  for (const validatedFile of files) {
    const storagePath =
      `${quoteRequestId}/${crypto.randomUUID()}.${validatedFile.extension}`;
    const { error: uploadError } = await supabase.storage
      .from("quote-request-files")
      .upload(storagePath, validatedFile.file, {
        contentType: validatedFile.contentType,
        upsert: false,
      });

    if (uploadError) {
      console.error("cutting quote file upload failed", uploadError.message);
      await cleanupUploadedFiles(supabase, quoteRequestId, uploadedPaths);
      await markFailed(supabase, quoteRequestId);
      return errorResponse(
        "file-upload-failed",
        "A fájl feltöltése nem sikerült.",
        500,
        origin,
      );
    }

    uploadedPaths.push(storagePath);
    fileRows.push({
      quote_request_id: quoteRequestId,
      storage_path: storagePath,
      original_name: validatedFile.originalName,
      content_type: validatedFile.contentType,
      size_bytes: validatedFile.file.size,
      file_purpose: filePurpose,
    });
  }

  if (fileRows.length) {
    const { error: fileRowsError } = await supabase
      .from("quote_request_files")
      .insert(fileRows);
    if (fileRowsError) {
      console.error("cutting quote file metadata insert failed", fileRowsError.code);
      await cleanupUploadedFiles(supabase, quoteRequestId, uploadedPaths);
      await markFailed(supabase, quoteRequestId);
      return errorResponse(
        "file-metadata-failed",
        "A fájl adatainak mentése nem sikerült.",
        500,
        origin,
      );
    }
  }

  const { data: readyRow, error: readyError } = await supabase
    .from("cutting_quote_requests")
    .update({ state: "ready" })
    .eq("quote_request_id", quoteRequestId)
    .eq("state", "ingesting")
    .select("quote_request_id")
    .maybeSingle();

  if (readyError || !readyRow) {
    console.error("cutting quote ready-state update failed", readyError?.code);
    await cleanupUploadedFiles(supabase, quoteRequestId, uploadedPaths);
    await markFailed(supabase, quoteRequestId);
    return errorResponse(
      "finalize-failed",
      "Az ajánlatkérés véglegesítése nem sikerült.",
      500,
      origin,
    );
  }

  const notification = await sendNotification({
    quoteRequestId,
    payload,
    files,
    summary,
    isPreview,
  });
  const notificationUpdate = notification.sent
    ? { notification_sent_at: new Date().toISOString(), notification_error: null }
    : { notification_sent_at: null, notification_error: notification.error };
  const { error: notificationUpdateError } = await supabase
    .from("quote_requests")
    .update(notificationUpdate)
    .eq("id", quoteRequestId);
  if (notificationUpdateError) {
    console.error(
      "cutting quote notification status update failed",
      notificationUpdateError.code,
    );
  }

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
