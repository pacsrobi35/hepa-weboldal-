# HEPA látogatói mérés

Élesítés: 2026. november 9. Saját első félként működő, külön statisztikai hozzájárulással induló mérés. GA4-fiókot nem hoz létre és nem használ. A korábbi Google Ads konverziómérés megmarad.

## Hol látható?

`https://hepabutor.hu/muhely#latogatasok`, a meglévő HEPA-admin belépéssel és kétlépcsős hitelesítéssel. A „Látogatói mérés” gomb megnyitja a kimutatást. Időszak: ma / 7 / 14 / 30 nap, Budapest szerinti napokkal; szűrés forrás és mobil/asztali nézet szerint.

## Mit mér?

- Oldalak, belépő és utolsó megfigyelt oldal, forráscsoport, számszerű Google Ads kampányazonosító.
- Blokkok, referenciák, lenyitások, görgetés 25/50/75/90%, aktív idő 10/30/60/120 másodperc.
- Telefon-, e-mail-, útvonal- és ajánlatkérő kattintások.
- Űrlap tényleges megjelenése, kitöltés kezdete, a lapszabászati kézi/feltöltés/segítségkérés egyes lépései.
- Kitöltési hiba általános csoportja, érvényes küldési kísérlet, hálózati/kiszolgálói hiba, adatbázisban ellenőrzött siker.
- A hozzájárulással mért ajánlatkéréshez kapcsolt ügy aktuális „ordered” állapota.

Egy látogatás nem egyedi ember: a véletlen munkamenet-azonosító 30 perc inaktivitás után újrakezdődik. Az utolsó oldal és befejezetlen űrlap csak 30 perc inaktivitás után kerül az elhagyási táblákba. A telefonkattintás nem hívás. A forrásnál a „közvetlen” a nem azonosítható érkezést is magában foglalja; a kampányazonosító csak a számszerű UTM értékből származik.

## Hozzájárulás és adatminimalizálás

A régi hirdetésmérési engedély nem indítja el az új statisztikát. Korábbi elutasítás megmarad. A látogató választhat: „Elutasítom”, „Csak statisztika”, „Mindet engedélyezem”. Statisztikai engedély előtt nincs statisztikai hálózati kérés vagy munkamenet-tár. Korábbi műveleteket nem küldünk visszamenőleg. Visszavonás leállítja/abortálja a küldést és törli a saját böngészőmérési tárat.

Nincs mezőérték, fájlnév, e-mail, telefonszám, üzenet, hibaüzenet-szöveg, teljes URL/referrer, nyers keresés, Google click ID, IP-rögzítés a statisztikai táblában, ujjlenyomat vagy munkamenet-felvétel. A tárhelyszolgáltató szokásos technikai naplói ettől elkülönülnek. Harmincnapos jelentési ablak, beérkező csomagonként legfeljebb 1000 lejárt esemény törlése. Inaktív időszakban lejárt esemény maradhat a privát táblában a következő tisztításig.

## Adatút és védelem

`visitor-measurement.js` → `visitor-measurement` Edge Function → csak service_role számára hívható `record_visitor_measurement` → `private.visitor_events`.

A collector csak a két production originről fogad kérelmet, a nyilvános klienskulcs ellenőrzésével. Ez a kulcs nem titok és nem bizonyít látogatói személyazonosságot. A csomag 16 KiB, legfeljebb 20 esemény; célok és eseménytípusok szigorú engedélylistán. Duplikációt esemény-UUID szűr. Munkamenetenként kb. 200, 24 órában kb. 25 000 eseményes korlát. A böngészős visszajelzések hamisíthatók; a sikeres ajánlatkérésnél ezért a kész, website forrású, legfeljebb 24 órás ügyet a backend ellenőrzi. Az adminriport külön ellenőrzött felhasználót, aláírás-ellenőrzött AAL2 claimet és admin_users tagságot igényel. Nincs névtelen vagy általános bejelentkezett hozzáférés a táblához/RPC-hez.

Teszteléshez a belépő URL-en `?meres_teszt=1` használható; a tesztmunkamenet végig kizárt a normál kimutatásból. Automatikus webdriver-böngészőből nem gyűjtünk. Az ügyfélkezelőt és az adatkezelési oldalt nem elemezzük.

## Ellenőrzések

`node --test tests/visitor-measurement.test.mjs supabase/functions/visitor-measurement/index.test.mjs tests/callback.test.mjs tests/lead-funnel.test.mjs tests/cutting-draft-privacy.test.mjs`

Adatbázis: `supabase/tests/visitor_measurement_live_smoke.sql` visszagörgetett teszt, deduplikációval, ellenőrzött sikerrel, ügyállapot-kapcsolattal, szűréssel, tesztkizárással és jogosultságvizsgálattal. A fixture-ügyet nem küldjük be a nyilvános ajánlatkérőn, e-mail nem keletkezik.

Az adatbázis-migrációt a Supabase natív migrációs eszköze alkalmazta; a generált verzió: `20261109192456`. Az Edge Function saját hitelesítést végez, ezért a gateway verify_jwt kikapcsolt; a riport saját JWT/Admin/AAL2 ellenőrzése kötelező. A korábbi funnel collectorhoz és ügyféladatokhoz nem nyúl.
