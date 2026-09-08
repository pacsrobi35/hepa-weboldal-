# HEPA adatbázis és szerverfunkciók

Ez a dokumentum a `torczkyodukcvxwzutgf` Supabase-projekt 2026. szeptember 8-i,
Gitben is rögzített állapotát írja le.

## Mi működik jelenleg?

### Nyilvános ajánlatkérés

1. A weboldal a `submit-quote-request` Edge Functionnek küldi az űrlapot.
2. A függvény ellenőrzi a mezőket, a hozzájárulást, a fájltípusokat és a méretkorlátot.
3. A visszaéléseket honeypot, idempotencia-token és IP-alapú korlátozás mérsékli.
4. Az ajánlatkérés a `quote_requests`, a fájlok metaadatai a
   `quote_request_files` táblába kerülnek.
5. A csatolmányok a privát `quote-request-files` Storage bucketbe kerülnek.
6. A rendszer e-mail-értesítést küld, és eltárolja annak eredményét.

### Referenciák

- A képek a nyilvános `reference-images` bucketben találhatók.
- A leíró adatok a `reference_images` táblában vannak.
- A `list-reference-images` Edge Function csak a közzétett képeket és a
  megjelenítéshez szükséges mezőket adja vissza.
- A feltöltő/admin kezelőfelület még nem része a repónak; ez a következő fejlesztési szelet.

### Árajánlatok

- Az ajánlatok a `quote_offers`, tételeik a `quote_offer_items` táblában vannak.
- A `save_quote_offer` adatbázis-függvény ellenőrzi a tételeket, kiszámolja a
  nettó, áfa-, bruttó és előlegösszeget, majd egy tranzakcióban ment.
- A `send-quote-offer` Edge Function csak bejelentkezett HEPA-adminnak küld e-mailt.
- Sikeres küldés után a `mark_quote_offer_sent` rögzíti a kiküldést és frissíti
  az ajánlatkérés állapotát.

## Adatmodell

| Tábla | Feladat |
| --- | --- |
| `profiles` | admin felhasználói profil |
| `admin_users` | engedélyezett HEPA-adminok |
| `quote_requests` | webes ajánlatkérések és állapotuk |
| `quote_request_files` | ajánlatkéréshez tartozó csatolmányok metaadatai |
| `quote_submission_attempts` | rövid életű rate-limit rekordok |
| `quote_offers` | előzetes és végleges árajánlatok |
| `quote_offer_items` | árajánlat-tételek |
| `reference_images` | referenciaképek kategóriája és megjelenítési adatai |

Az online lapszabászat táblái még nem léteznek. Az anyagok, szabáslisták,
rendelések, előlegek, számlák és kintlévőségek modelljét erre az ellenőrzött
alapra építjük rá, új migrációkkal.

## Hozzáférések

| Szerepkör | Engedély |
| --- | --- |
| `anon` | csak a közzétett referenciák hét biztonságos mezőjének olvasása |
| `authenticated` | saját profil; admin-tagság esetén ajánlatkérések, ajánlatok és referenciák kezelése |
| `service_role` | szerveroldali teljes DML-hozzáférés; jelenleg az ajánlatkérő használja |

Minden alkalmazástáblán aktív a Row Level Security. Az adatbázis-függvények
`security invoker` módban, rögzített üres `search_path` beállítással futnak.
Az új `public` objektumok nem kapnak automatikusan API-jogosultságot; minden új
migrációban külön kell megadni a szükséges engedélyeket.

Az élő projektben a Supabase által kezelt `ensure_rls` eseménytrigger is
automatikusan bekapcsolja az RLS-t az új `public` táblákon. Ez projektbeállítás,
nem része a migrációs láncnak; ettől függetlenül minden új HEPA-táblán a saját
migrációjában is explicit módon engedélyezni kell az RLS-t.

## Storage

| Bucket | Láthatóság | Típusok | Korlát |
| --- | --- | --- | --- |
| `quote-request-files` | privát | JPG, PNG, WebP, PDF | 10 MiB/fájl |
| `reference-images` | nyilvános | JPG, PNG, WebP, AVIF | 10 MiB/fájl |

Fontos: egy nyilvános bucketben az `is_published = false` csak a galériából
rejti el a képet. Aki ismeri a közvetlen objektum-URL-t, továbbra is eléri azt.
Ide ezért csak nyilvánosságra szánt referenciakép tölthető fel.

## Migrációk

Az aktív lánc sorrendben:

1. `20260904000100_hepa_production_baseline.sql`
2. `20260905054613_protect_quote_submissions_and_track_notifications.sql`
3. `20260905055447_make_quote_rate_limit_atomic.sql`
4. `20260906200930_add_reference_image_library.sql`
5. `20260906201509_optimize_reference_image_policies.sql`
6. `20260906224101_add_quote_submission_token.sql`
7. `20260907000000_capture_quote_offer_schema.sql`
8. `20260908165216_harden_hepa_application_privileges.sql`

Az első és a hetedik fájl korábban közvetlenül létrehozott termelési objektumokat
rögzít utólag. Az élő projekt migrációs előzményeiben alkalmazottként szerepelnek,
de a DDL-jük ott nem futott le újra. Új, üres projektben a teljes lánc futtatandó.
Új termelési projekt indítása előtt a Storage-ot és a cronfeladatot is magában
foglaló teljes láncot eldobható fejlesztői ágon vagy helyi Supabase-ben is végig
kell futtatni.

## Edge Function konfiguráció

A `supabase/config.toml` rögzíti:

- `submit-quote-request`: publikus végpont, `verify_jwt = false`, saját bemenet-
  ellenőrzéssel és rate limittel;
- `list-reference-images`: publikus, csak olvasó végpont, `verify_jwt = false`;
- `send-quote-offer`: admin végpont, `verify_jwt = true`, ezen felül admin-tagságot is ellenőriz.

A jelenlegi engedélyezett böngészős origin a Vercel-oldal és a két helyi
fejlesztői cím. Az új, HEPA tulajdonú domaint kiválasztás után mindkét publikus
függvény CORS-listájához hozzá kell adni.

## Környezeti változók

| Változó | Hely | Feladat |
| --- | --- | --- |
| `SUPABASE_URL` | Supabase által biztosított | projekt API-címe |
| `SUPABASE_PUBLISHABLE_KEYS` | Supabase által biztosított | publikus/admin klienskapcsolat |
| `SUPABASE_SECRET_KEYS` | Supabase által biztosított | ajánlatkérés szerveroldali mentése |
| `RESEND_API_KEY` | Edge Function Secret | e-mail-küldés |
| `QUOTE_NOTIFICATION_FROM` | opcionális Edge Function Secret | új érdeklődés értesítő feladója |
| `QUOTE_OFFER_FROM` | Edge Function Secret | ügyfélnek küldött ajánlat feladója |
| `QUOTE_OFFER_REPLY_TO` | opcionális Edge Function Secret | válaszcím |

A legacy `SUPABASE_ANON_KEY` és `SUPABASE_SERVICE_ROLE_KEY` csak átmeneti
visszafelé kompatibilis tartalék. A modern `SUPABASE_PUBLISHABLE_KEYS` és
`SUPABASE_SECRET_KEYS` értéke JSON-objektum, benne a `default` kulccsal.

## Új környezet indítási sorrendje

1. Futtasd le sorrendben az összes migrációt.
2. A Supabase Auth felületén hozz létre vagy hívj meg egy kizárólag HEPA által
   használt adminfelhasználót; a nyilvános regisztráció maradjon kikapcsolva.
3. Az Auth-felhasználó UUID-jával hozz létre egy `profiles` rekordot és egy
   `admin_users` tagságot. Ezt csak tulajdonosi SQL-munkamenetből szabad megtenni.
4. Állítsd be a szükséges Resend-változókat az Edge Function Secrets résznél.
5. Telepítsd a három Edge Functiont a `supabase/config.toml` beállításaival.
6. Az adminfelület használata előtt állíts be erős, egyedi jelszót és TOTP MFA-t,
   majd ellenőrizd külön a nyilvános ajánlatkérést, a referencialistát és az adminbelépést.

## Következő biztonságos lépések

1. Az admin belépésnél nyilvános regisztráció tiltása, erős egyedi jelszó és TOTP MFA.
2. A privát HEPA Műhely felület és a referenciafeltöltő elkészítése; ekkor kap
   böngészős CORS/OPTIONS-kezelést a `send-quote-offer` végpont is.
3. Adatmegőrzési/törlési művelet az ajánlatkérésekhez és csatolmányokhoz.
4. A saját domain CORS-, canonical-, sitemap- és robots-beállítása.
5. Az online lapszabászat külön adatmodelljének és kezelőfelületének fejlesztése.
