# HEPA Lapszabászat és Bútorgyártás

A HEPA nyilvános weboldala és a készülő online ajánlatkérő rendszer alapja.

## Rendszerfelépítés

- `index.html` – nyilvános weboldal
- `supabase/functions/submit-quote-request/` – az ajánlatkérések biztonságos fogadása, ellenőrzése, fájlmentése és e-mail-értesítése
- `supabase/migrations/` – az árajánlatok, rendelések, ügyfelek, szabásjegyzékek, csatolmányok és pénzügyek közös adatbázisa
- `docs/adatbazis-alap.md` – állapotok, biztonsági elvek és bekapcsolási sorrend

A nyilvános űrlap közvetlenül a `submit-quote-request` Supabase Edge Functiont hívja. Ez az egyetlen támogatott fogadóútvonal; a titkos adatbáziskulcs kizárólag a Supabase szerveroldali környezetében marad.

A Supabase titkos kulcsa soha nem kerülhet a repóba vagy böngészőben futó kódba. A szükséges változónevek az `.env.example` fájlban találhatók.
