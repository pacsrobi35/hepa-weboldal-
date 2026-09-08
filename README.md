# HEPA Lapszabászat és Bútorgyártás

A HEPA nyilvános weboldala és Supabase-alapú ajánlatkérő háttere.

## Jelenlegi rendszer

- `index.html` – a nyilvános, Vercelen futó weboldal és ajánlatkérő űrlap
- `supabase/functions/submit-quote-request/` – ajánlatkérések ellenőrzése, mentése, fájlfeltöltése és e-mail-értesítése
- `supabase/functions/list-reference-images/` – a közzétett referenciaképek biztonságos listázása
- `supabase/functions/send-quote-offer/` – admin által készített árajánlat elküldése
- `supabase/migrations/` – az élő adatmodell verziózott migrációs lánca
- `docs/adatbazis-alap.md` – adatmodell, jogosultságok és üzemeltetési tudnivalók

Az adatbázis jelenleg az ügyfelektől érkező ajánlatkéréseket, csatolmányokat,
árajánlatokat és referenciaképeket kezeli. Az online lapszabászat rendelési,
anyag- és pénzügyi modellje egy későbbi, külön migrációban készül el.

## Biztonsági alapelvek

- Titkos Supabase- vagy Resend-kulcs nem kerülhet Gitbe vagy böngészőben futó kódba.
- A nyilvános ajánlatkérő kizárólag a `submit-quote-request` Edge Functionön keresztül írhat adatot.
- Minden alkalmazástábla RLS-védelemmel működik.
- A referencia API csak a közzétett képek szükséges, nem érzékeny mezőit olvashatja.
- Az adminfunkciók bejelentkezett, az `admin_users` táblában engedélyezett felhasználóhoz kötöttek.

A helyi fejlesztéshez szükséges változónevek az `.env.example` fájlban vannak;
értéket és titkot ez a fájl nem tartalmaz.

## Fejlesztés és telepítés

A függvények JWT-beállításait a `supabase/config.toml` rögzíti. Új adatbázis-
módosítás kizárólag új, időbélyeges migrációval készülhet. A termelési adatbázison
`db reset` nem futtatható.

Részletes leírás: [`docs/adatbazis-alap.md`](docs/adatbazis-alap.md).
