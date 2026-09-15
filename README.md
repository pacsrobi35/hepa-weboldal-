# HEPA Lapszabászat és Bútorgyártás

A HEPA nyilvános weboldala és Supabase-alapú ajánlatkérő háttere.

## Jelenlegi rendszer

- `index.html` – a nyilvános, Vercelen futó weboldal és bútoros ajánlatkérő űrlap
- `lapszabaszat.html` és `lapszabaszat-ajanlatkeres.html` – a külön lapszabászati céloldal és ajánlatkérő
- `muhely.html`, `muhely.css`, `muhely.js` – a nem linkelt, AAL2-védett HEPA Műhely olvasófelülete
- `supabase/functions/submit-quote-request/` – bútoros ajánlatkérések ellenőrzése, mentése, fájlfeltöltése és e-mail-értesítése
- `supabase/functions/submit-cutting-quote-request/` – lapszabászati ajánlatkérések, anyagok és tételsorok biztonságos mentése
- `supabase/functions/list-reference-images/` – a közzétett referenciaképek biztonságos listázása
- `supabase/functions/send-quote-offer/` – admin által készített árajánlat elküldése
- `supabase/migrations/` – az élő adatmodell verziózott migrációs lánca
- `docs/adatbazis-alap.md` – adatmodell, jogosultságok és üzemeltetési tudnivalók

Az adatbázis jelenleg a bútoros és lapszabászati ajánlatkéréseket, csatolmányokat,
árajánlatokat és referenciaképeket kezeli. A lapszabászati első verzió ajánlatot kér;
a későbbi automatikus árkalkulációhoz az anyagok és tételsorok már strukturáltan kerülnek mentésre.

## Biztonsági alapelvek

- Titkos Supabase- vagy Resend-kulcs nem kerülhet Gitbe vagy böngészőben futó kódba.
- A nyilvános ajánlatkérő kizárólag a `submit-quote-request` Edge Functionön keresztül írhat adatot.
- Minden alkalmazástábla RLS-védelemmel működik.
- A referencia API csak a közzétett képek szükséges, nem érzékeny mezőit olvashatja.
- Az adminfunkciók bejelentkezett, TOTP MFA-val AAL2-re hitelesített és az `admin_users` táblában engedélyezett felhasználóhoz kötöttek.
- A Műhely első kiadása csak olvas; módosító művelet csak külön naplózással kerülhet bele.
- A Műhely munkamenete lapbezáráskor megszűnik, és 30 perc inaktivitás után automatikusan kijelentkezik.

A helyi fejlesztéshez szükséges változónevek az `.env.example` fájlban vannak;
értéket és titkot ez a fájl nem tartalmaz.

## Fejlesztés és telepítés

A függvények JWT-beállításait a `supabase/config.toml` rögzíti. Új adatbázis-
módosítás kizárólag új, időbélyeges migrációval készülhet. A termelési adatbázison
`db reset` nem futtatható.

Részletes leírás: [`docs/adatbazis-alap.md`](docs/adatbazis-alap.md).
