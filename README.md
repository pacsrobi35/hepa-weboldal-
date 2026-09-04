# HEPA Lapszabászat és Bútorgyártás

A HEPA nyilvános weboldala és a készülő online ajánlatkérő rendszer alapja.

## Rendszerfelépítés

- `index.html` – nyilvános weboldal
- `api/quotes.js` – a bútoros árajánlatkérések szerveroldali fogadása
- `supabase/migrations/` – az árajánlatok, rendelések, ügyfelek, szabásjegyzékek, csatolmányok és pénzügyek közös adatbázisa
- `docs/adatbazis-alap.md` – állapotok, biztonsági elvek és bekapcsolási sorrend

A Supabase titkos kulcsa soha nem kerülhet a repóba vagy böngészőben futó kódba. A szükséges változónevek az `.env.example` fájlban találhatók.
