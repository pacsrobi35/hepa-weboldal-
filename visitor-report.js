(() => {
  'use strict';
  const SOURCE = {direct:'Közvetlen / ismeretlen',google_ads:'Google Ads',google_organic:'Google keresés',facebook:'Facebook',instagram:'Instagram',bing:'Bing',referral:'Más weboldal',other_campaign:'Egyéb kampány'};
  const PAGE = {'/':'Főoldal','/konyhabutor.html':'Konyhabútor','/lapszabaszat.html':'Lapszabászat','/lapszabaszat-ajanlatkeres.html':'Szabászati ajánlatkérő'};
  const STAGE = {page_view:'Kapcsolódó oldal megtekintése',cta_click:'Ajánlatkérő gomb',form_view:'Űrlap megjelenése',form_start:'Kitöltés megkezdése',submit_attempt:'Érvényes küldési kísérlet',submit_success:'Visszaigazolt ajánlatkérés'};
  const TARGET = {hero:'Nyitórész',references:'Referenciák',process:'Rendelés menete',reviews:'Ügyfélvélemények',service_area:'Vállalási terület',callback:'Bútoros visszahívás',cutting_intro:'Lapszabászat bemutatása',pricing:'Ártájékoztatás',faq:'Gyakori kérdések',cutting:'Lapszabászat',phone:'Telefon',email:'E-mail',directions:'Útvonal',konyha:'Konyhák',gardrob:'Gardróbok',eloszoba:'Előszoba',furdo:'Fürdőszoba',nappali:'Nappali',egyedi:'Egyedi bútor',showcase:'Referenciakép nagyítása',project:'Egy munka további képei',gallery:'További munkák',optional:'Nem kötelező űrlapadatok',name:'Név',city:'Település / irányítószám',privacy:'Adatkezelési elfogadás',file:'Fájl',items:'Tételek / méretek',material:'Anyag / ABS',delivery:'Átvétel / időzítés',description:'Leírás',form:'Űrlapadat',network:'Hálózati kapcsolódás',timeout:'Időtúllépés',server:'Kiszolgálóhiba',rejected:'Visszautasított beküldés',unknown:'Ismeretlen hiba',image:'Képbetöltés',script:'Program / szkript',style:'Stíluslap',choose:'Indulási mód választása'};
  const EVENTS = {section_view:'Blokk megtekintése',reference_view:'Referencianézés',scroll_depth:'Görgetés',engaged:'Aktív idő',cta_click:'Kattintás',details_open:'Lenyitás',validation_error:'Kitöltési hiba',submit_error:'Beküldési hiba',resource_error:'Betöltési hiba'};
  const number = n => new Intl.NumberFormat('hu-HU').format(Number(n)||0);
  const el = (tag,text,className) => {const n=document.createElement(tag);if(text!==undefined)n.textContent=String(text);if(className)n.className=className;return n;};
  let db, panel, generation=0;
  function table(title,headers,rows) {
    const section=el('section',undefined,'visitor-block');section.append(el('h3',title));
    if(!rows.length){section.append(el('p','Ebben az időszakban még nincs mért adat.','muted'));return section;}
    const wrap=el('div',undefined,'visitor-table-wrap'),t=el('table'),head=el('tr');
    for(const h of headers){const th=el('th',h);th.scope='col';head.append(th);}const thead=el('thead');thead.append(head);t.append(thead);
    const body=el('tbody');for(const row of rows){const tr=el('tr');for(const cell of row)tr.append(el('td',cell));body.append(tr);}t.append(body);wrap.append(t);section.append(wrap);return section;
  }
  function stepLabel(value) {
    if(value==='choose')return TARGET.choose;
    const [flow,step]=value.split(':');return ({manual:'Kézi lista',upload:'Feltöltés',help:'Segítségkérés'}[flow]||flow)+' · '+({items:'Tételek',details:'Tartalom',logistics:'Átvétel',contact:'Kapcsolat',review:'Ellenőrzés'}[step]||step);
  }
  function render(report) {
    const content=panel.querySelector('[data-visitor-content]');content.replaceChildren();
    const summary=el('div',undefined,'summary-grid visitor-summary');
    for(const [key,label] of Object.entries({visits:'Mért látogatások',page_views:'Oldalmegtekintések',leads:'Ajánlatkérések',phone_clicks:'Telefonra kattintók',errors:'Hibát tapasztaló látogatások',orders:'Megrendelt státusz'})){
      const c=el('article',undefined,'summary-card');c.append(el('span',label),el('strong',number(report.summary[key])));summary.append(c);
    }content.append(summary);
    const stamp=new Intl.DateTimeFormat('hu-HU',{timeZone:'Europe/Budapest',dateStyle:'short',timeStyle:'short'}).format(new Date(report.generated_at));
    content.append(el('p','Frissítve: '+stamp+'. A tesztlátogatások nem szerepelnek a számokban.','muted'));
    if(!report.summary.visits)content.append(el('p','A mérés be van kötve. Az élesítés utáni, statisztikát engedélyező látogatásokból fog feltöltődni ez a kimutatás.','visitor-notice'));
    else if(report.summary.leads<10)content.append(el('p','Még kevés az ajánlatkérés: az eltérések irányt mutathatnak, de önmagukban nem bizonyítják a lemorzsolódás okát.','visitor-notice'));
    const funnels=el('div',undefined,'visitor-columns');
    for(const [f,label] of [['callback','Bútorgyártás · visszahívás'],['cutting','Lapszabászat']]){
      const rows=Object.entries(STAGE).map(([key,label])=>[label,number(report.funnels.find(r=>r.funnel===f&&r.stage===key)?.sessions)]);
      funnels.append(table(label,['Mért lépés','Látogatás'],rows));
    }content.append(funnels);
    content.append(el('p','A lépések külön események: egy látogatás során több oldal vagy űrlap is megnyílhat. A gombkattintás és a telefonra kattintás nem jelent beküldést vagy létrejött hívást.','muted'));
    content.append(table('Honnan érkeztek?',['Forrás','Kampányazonosító','Látogatás','Ajánlatkérés'],report.sources.map(r=>[SOURCE[r.source]||r.source,r.campaign_id||'—',number(r.visits),number(r.leads)])));
    content.append(table('Oldalak és utolsó megfigyelt oldal',['Oldal','Látogatás','Megtekintés','Belépő oldal','Utolsó oldal*'],report.pages.map(r=>[PAGE[r.page]||r.page,number(r.visits),number(r.page_views),number(r.entries),number(r.last_observed)])));
    content.append(el('p','* Csak legalább 30 perce inaktív mért látogatások. Az utolsó megfigyelt oldal nem bizonyítja, hogy miért távozott valaki.','muted'));
    content.append(table('Befejezetlen lapszabászati utak · utolsó lépés',['Utoljára mért lépés','Látogatás'],report.steps.map(r=>[stepLabel(r.target),number(r.sessions)])));
    content.append(table('Kitöltési, beküldési és betöltési hibák',['Hibatípus','Érintett rész','Oldal','Nézet','Látogatás'],report.errors.map(r=>[EVENTS[r.event]||r.event,TARGET[r.target]||r.target,PAGE[r.page]||r.page,r.device==='mobile'?'Mobil':'Asztali',number(r.sessions)])));
    content.append(table('Mivel foglalkoztak az oldalon?',['Esemény','Részlet','Oldal','Látogatás'],report.engagement.map(r=>[EVENTS[r.event]||r.event,r.event==='scroll_depth'?r.target+'%':r.event==='engaged'?r.target+' mp aktív idő':TARGET[r.target]||r.target,PAGE[r.page]||r.page,number(r.sessions)])));
    content.append(table('Naponta',['Nap','Látogatás','Ajánlatkérő látogatás'],report.daily.map(r=>[r.day,number(r.visits),number(r.leads)])));
  }
  async function load() {
    const version=++generation,status=panel.querySelector('[data-visitor-status]'),button=panel.querySelector('[data-visitor-refresh]');
    status.textContent='A látogatási adatok betöltése…';button.disabled=true;
    try{
      const {data,error}=await db.functions.invoke('visitor-measurement',{body:{action:'report',days:Number(panel.querySelector('[name="visitor-days"]').value),device:panel.querySelector('[name="visitor-device"]').value,source:panel.querySelector('[name="visitor-source"]').value}});
      if(version!==generation)return;
      if(error||data?.ok!==true||!data.report)throw new Error('report-unavailable');
      render(data.report);status.textContent='';
    }catch{if(version===generation){status.textContent='Nem sikerült betölteni a kimutatást. Ellenőrizd a belépést, majd próbáld újra. Adathiba esetén nem jelenítünk meg nullának látszó eredményt.';panel.querySelector('[data-visitor-content]').replaceChildren();}}
    finally{if(version===generation)button.disabled=false;}
  }
  function setup(client) {
    db=client;panel=document.querySelector('#visitor-panel');if(!db||!panel)return;
    const toggle=document.querySelector('#visitor-toggle');
    toggle.addEventListener('click',()=>{panel.hidden=!panel.hidden;toggle.setAttribute('aria-expanded',String(!panel.hidden));if(!panel.hidden){location.hash='latogatasok';load();}});
    panel.querySelector('[data-visitor-refresh]').addEventListener('click',load);
    panel.querySelectorAll('select').forEach(select=>select.addEventListener('change',load));
  }
  window.HEPAVisitorReport=Object.freeze({setup,
    openIfRequested(){if(location.hash==='#latogatasok'&&panel){panel.hidden=false;document.querySelector('#visitor-toggle').setAttribute('aria-expanded','true');load();}},
    reset(){generation++;if(panel){panel.hidden=true;panel.querySelector('[data-visitor-content]').replaceChildren();panel.querySelector('[data-visitor-status]').textContent='';document.querySelector('#visitor-toggle').setAttribute('aria-expanded','false');panel.querySelector('[data-visitor-refresh]').disabled=false;}}
  });
})();
