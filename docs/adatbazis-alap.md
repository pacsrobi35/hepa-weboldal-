# HEPA közös adatbázis-alap

Ez az adatmodell közös helyen kezeli az egyedi bútoros árajánlatkéréseket, az online lapszabászati rendeléseket és a műhelyben kézzel felvett munkákat.

## Központi működés

- Minden munka egy `jobs` rekord, saját `HEPA-ÉÉÉÉ-xxxxx` azonosítóval.
- A munka típusa jelzi, hogy bútoros ajánlatkérés vagy lapszabászati rendelés.
- Az elfogadott ajánlat nem kerül új táblába: ugyanaz a munka halad tovább az állapotokon.
- Az ügyfél, a csatolmányok, a szabásjegyzék, a számlák és a fizetések ehhez a munkához kapcsolódnak.
- A `job_financial_summary` nézet számolja a befizetett előleget és a kintlévőséget.

## Állapotok és magyar feliratuk

| Adatbázis-kód | HEPA Műhely felirat |
| --- | --- |
| `new` | Új / függő |
| `estimating` | Kalkuláció |
| `quote_sent` | Ajánlat elküldve |
| `accepted` | Elfogadva |
| `deposit_pending` | Előlegre vár |
| `deposit_paid` | Előleg beérkezett |
| `cutting` | Szabás alatt |
| `edgebanding` | Élzárás alatt |
| `ready` | Elkészült |
| `invoicing` | Számlázás |
| `payment_pending` | Fizetésre vár |
| `closed` | Lezárva |
| `cancelled` | Törölve |

## Biztonsági elv

A nyilvános weboldal nem kap közvetlen hozzáférést az adatbázishoz. Az űrlap a Vercel szerveroldali `/api/quotes` végpontját hívja, és csak ez a végpont használja a Supabase titkos kulcsát. A kulcs kizárólag Vercel Secret környezeti változóban tárolható.

Az adatbázis minden üzleti tábláján aktív a Row Level Security. A nyilvános és az egyszerűen bejelentkezett Supabase-szerepkörök nem kapnak közvetlen olvasási vagy írási jogot. A későbbi HEPA Műhely felület saját szerveroldali jogosultság-ellenőrzést kap.

## Bekapcsolás

1. Hozz létre egy HEPA tulajdonú Supabase-projektet egy EU-s régióban.
2. A Supabase SQL Editorban futtasd a `supabase/migrations/202609040001_hepa_core.sql` fájlt.
3. Hozz létre egy `hepa-private` nevű privát Storage bucketet a képeknek, terveknek és PDF-eknek.
4. A Vercel projektben Secret változóként add meg a `SUPABASE_URL` és `SUPABASE_SECRET_KEY` értékét.
5. Ezután kapcsolható át a weboldal árajánlatkérője a valódi mentésre és a privát fájlfeltöltésre.

## Következő fejlesztési szeletek

1. A jelenlegi árajánlatkérő összekötése az API-val, adatkezelési jelölőnégyzettel és valós hiba-/sikerüzenettel.
2. A csatolmányok biztonságos, közvetlen feltöltése a privát Storage-ba.
3. A HEPA Műhely belépés és az „Új ajánlatkérések” lista.
4. Az online lapszabászat szabásjegyzéke és anyagválasztója ugyanebben az adatbázisban.
5. Előleg, számla, fizetés és kintlévőség kezelése.

