/* Optional HEPA analytics: no network/storage until a separate statistics choice. */
(() => {
  'use strict';
  const PAGES = new Set(['/', '/konyhabutor.html', '/lapszabaszat.html', '/lapszabaszat-ajanlatkeres.html']);
  const TARGETS = {
    page_view: [''], section_view: ['hero','references','process','reviews','service_area','callback','cutting_intro','pricing','faq'],
    scroll_depth: ['25','50','75','90'], engaged: ['10','30','60','120'],
    cta_click: ['callback','cutting','phone','email','directions'],
    reference_view: ['konyha','gardrob','eloszoba','furdo','nappali','egyedi','showcase'],
    details_open: ['faq','project','gallery','optional'], form_view: ['callback','cutting'], form_start: ['callback','cutting'],
    form_step: ['choose','manual:items','manual:logistics','manual:contact','manual:review','upload:details','upload:logistics','upload:contact','upload:review','help:details','help:contact','help:review'],
    validation_error: ['name','phone','city','email','privacy','file','items','material','delivery','description','form'],
    submit_attempt: ['callback','cutting'], submit_error: ['network','timeout','server','rejected','file','unknown'],
    submit_success: ['callback','cutting'], resource_error: ['image','script','style']
  };
  function classifySource(href, referrer) {
    const url = new URL(href);
    const p = url.searchParams, source = (p.get('utm_source') || '').toLowerCase();
    if (p.has('gclid') || p.has('gbraid') || p.has('wbraid') || (source === 'google' && /^(cpc|ppc|paidsearch)$/.test(p.get('utm_medium') || ''))) return 'google_ads';
    if (/^(facebook|fb)$/.test(source)) return 'facebook';
    if (/^(instagram|ig)$/.test(source)) return 'instagram';
    if (source) return 'other_campaign';
    let host = '';
    try { host = new URL(referrer).hostname; } catch { /* Direct arrival. */ }
    if (/(^|\.)google\.[a-z.]+$/.test(host)) return 'google_organic';
    if (/(^|\.)facebook\.com$/.test(host)) return 'facebook';
    if (/(^|\.)instagram\.com$/.test(host)) return 'instagram';
    if (/(^|\.)bing\.com$/.test(host)) return 'bing';
    return host && host !== url.hostname && !['hepabutor.hu','www.hepabutor.hu'].includes(host) ? 'referral' : 'direct';
  }
  const cleanCampaign = value => /^\d{1,20}$/.test(value || '') ? value : '';
  function fieldGroup(id) {
    if (/privacy|consent/.test(id)) return 'privacy';
    if (/email/.test(id)) return 'email';
    if (/phone/.test(id)) return 'phone';
    if (/name/.test(id)) return 'name';
    if (/city|location|postal/.test(id)) return 'city';
    if (/file|attach|upload-drop/.test(id)) return 'file';
    if (/material|thickness|edge-profile/.test(id)) return 'material';
    if (/item|size|quantity|length|width|edge/.test(id)) return 'items';
    if (/fulfillment|date|logistic/.test(id)) return 'delivery';
    if (/description|message|topics/.test(id)) return 'description';
    return 'form';
  }
  const allowedEvent = (type, target) => !!TARGETS[type]?.includes(target);
  if (typeof module === 'object' && module.exports) { module.exports = { classifySource, cleanCampaign, fieldGroup, allowedEvent }; return; }
  const page = location.pathname === '/index.html' ? '/' : location.pathname;
  if (!['hepabutor.hu','www.hepabutor.hu'].includes(location.hostname) || !PAGES.has(page) || navigator.webdriver) return;
  const ENDPOINT = 'https://torczkyodukcvxwzutgf.supabase.co/functions/v1/visitor-measurement';
  const KEY = 'hepa-visits-v1', QUEUE_KEY = 'hepa-visits-pending-v1';
  const publicKey = 'sb_publishable_DPpJ2bkxAvoo6Xqp_gDi2g_oGRNIIbl';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  let enabled = false, session, viewId, pageStarted = false, marks = new Set(), packets = [], running = false, generation = 0;
  let observer, mutationObserver, timer, activeSeconds = 0, lastInput = Date.now(), lastTick = Date.now();
  const controllers = new Set();
  const granted = () => window.HEPAMarketing?.hasAnalyticsConsent?.() === true;
  const save = () => { try { sessionStorage.setItem(KEY, JSON.stringify(session)); sessionStorage.setItem(QUEUE_KEY, JSON.stringify(packets.slice(-5))); } catch { /* In-memory measurement still works. */ } };
  function ensureSession() {
    if (!session || Date.now() - session.lastActivity > 30 * 60 * 1000) {
      session = { token: crypto.randomUUID(), lastActivity: Date.now(), sequence: 0, source: classifySource(location.href, document.referrer),
        campaignId: cleanCampaign(new URL(location.href).searchParams.get('utm_campaign')), device: matchMedia('(max-width: 767px)').matches ? 'mobile' : 'desktop',
        isTest: new URL(location.href).searchParams.get('meres_teszt') === '1' };
      pageStarted = false; marks = new Set(); activeSeconds = 0;
    }
    session.lastActivity = Date.now();
    if (!pageStarted) {
      viewId = crypto.randomUUID(); pageStarted = true;
      add('page_view', '', '', 0);
    }
  }
  function add(type, target, funnel, value, submissionToken) {
    let packet = packets.at(-1);
    if (!packet || packet.pageViewId !== viewId || packet.events.length >= 20) {
      packet = { sessionToken: session.token, pageViewId: viewId, page, source: session.source, campaignId: session.campaignId, device: session.device, isTest: session.isTest, events: [] };
      packets.push(packet);
    }
    packet.events.push({ id: crypto.randomUUID(), type, target, funnel, value, sequence: ++session.sequence, ...(submissionToken ? { submissionToken } : {}) });
    packets = packets.slice(-5); save();
  }
  function record(type, target = '', funnel = '', value = 0, submissionToken) {
    if (!enabled || !granted() || !allowedEvent(type, target) || !['','callback','cutting'].includes(funnel)) return false;
    if (type === 'submit_success' && (!UUID.test(submissionToken || '') || target !== funnel)) return false;
    if (type !== 'submit_success' && submissionToken) return false;
    ensureSession();
    const key = [type,target,funnel,submissionToken || ''].join(':');
    if (type === 'page_view' || marks.has(key)) return false;
    marks.add(key);
    add(type,target,funnel,Math.max(0,Math.min(1800000,Math.round(Number(value) || 0))),submissionToken);
    if (['cta_click','submit_success','submit_error','submit_attempt'].includes(type)) flush();
    return true;
  }
  async function flush() {
    if (running || !enabled || !granted() || !packets.length) return;
    running = true;
    const current = generation;
    try {
      for (const packet of [...packets]) {
        if (!enabled || current !== generation) break;
        const batch = { ...packet, events: [...packet.events] }, ids = new Set(batch.events.map(e => e.id));
        const controller = new AbortController(); controllers.add(controller);
        const timeout = setTimeout(() => controller.abort(), 8000);
        try {
          const response = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: publicKey }, body: JSON.stringify(batch), credentials: 'omit', keepalive: true, signal: controller.signal });
          if (!response.ok) break;
          if (current !== generation || !enabled) break;
          packet.events = packet.events.filter(e => !ids.has(e.id));
          packets = packets.filter(p => p.events.length); save();
        } catch { break; } finally { clearTimeout(timeout); controllers.delete(controller); }
      }
    } finally { running = false; }
  }
  const funnelOf = form => form?.id === 'quoteForm' ? 'callback' : form?.id === 'cutting-form' ? 'cutting' : '';
  function viewForms() {
    if (!enabled) return;
    for (const form of document.querySelectorAll('#quoteForm, #cutting-form')) {
      const r = form.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.top < innerHeight * .85 && r.bottom > innerHeight * .15) record('form_view',funnelOf(form),funnelOf(form));
    }
  }
  function currentStep() {
    if (!enabled || !document.querySelector('#cutting-form')) return;
    if (document.querySelector('#wizard.active')) {
      const step = document.querySelector('.step-panel.active')?.dataset.step;
      const flow = document.querySelector('#wizard')?.dataset.measureFlow || new URL(location.href).searchParams.get('ut');
      if (allowedEvent('form_step', `${flow}:${step}`)) record('form_step',`${flow}:${step}`,'cutting');
    } else if (!document.querySelector('#success-panel.active')) record('form_step','choose','cutting');
  }
  function start() {
    if (enabled || !granted()) return;
    enabled = true; lastInput = Date.now(); lastTick = Date.now();
    try {
      const saved = JSON.parse(sessionStorage.getItem(KEY));
      if (UUID.test(saved?.token || '') && Number.isFinite(saved.lastActivity) && saved.lastActivity <= Date.now() && Date.now()-saved.lastActivity<1800000
        && Number.isInteger(saved.sequence) && saved.sequence<1000000 && ['mobile','desktop'].includes(saved.device)
        && ['direct','google_ads','google_organic','facebook','instagram','bing','referral','other_campaign'].includes(saved.source)
        && typeof saved.isTest==='boolean' && cleanCampaign(saved.campaignId)===saved.campaignId) session=saved;
      const queue = JSON.parse(sessionStorage.getItem(QUEUE_KEY));
      if (Array.isArray(queue)) packets=queue.filter(p=>p?.sessionToken===session?.token && PAGES.has(p.page) && Array.isArray(p.events) && p.events.length<=20).slice(-5);
    } catch { /* Storage is optional. */ }
    ensureSession(); viewForms(); currentStep();
    if (typeof IntersectionObserver === 'function') {
      observer = new IntersectionObserver(entries => {
        for (const entry of entries) if (entry.isIntersecting) {
          const target = entry.target.dataset.hepaMeasureSection;
          if (target) record('section_view',target);
        }
      }, { threshold: .15 });
      const sections = { '.hero':'hero', '#tervbol-valosag':'references', '#butorgyartas':'references', '#referenciak':'references', '#rendeles-menete':'process', '#ugyfeleink':'reviews', '#vallalasi-terulet':'service_area', '#ajanlat':'callback', '.cutting-hero':'cutting_intro', '.process-section':'process', '.price-trust':'pricing', '.faq-section':'faq' };
      for (const [selector,target] of Object.entries(sections)) for (const node of document.querySelectorAll(selector)) { node.dataset.hepaMeasureSection=target; observer.observe(node); }
    }
    if (typeof MutationObserver === 'function') {
      mutationObserver = new MutationObserver(() => {
        currentStep();
        for (const node of document.querySelectorAll('#cutting-form [aria-invalid="true"]')) record('validation_error',fieldGroup(node.id),'cutting');
      });
      const form = document.querySelector('#cutting-form');
      if (form) mutationObserver.observe(form,{subtree:true,attributes:true,attributeFilter:['class','aria-invalid','hidden']});
    }
    timer = setInterval(() => {
      const now=Date.now(), delta=Math.max(0,Math.min(2,(now-lastTick)/1000)); lastTick=now;
      if (!document.hidden && now-lastInput<60000) {
        activeSeconds += delta;
        for (const s of [10,30,60,120]) if (activeSeconds>=s) record('engaged',String(s));
      }
      viewForms(); flush();
    }, 2000);
    flush();
  }
  function stop() {
    enabled=false; generation++; packets=[]; session=null; pageStarted=false; marks.clear();
    observer?.disconnect(); mutationObserver?.disconnect(); clearInterval(timer);
    for (const controller of controllers) controller.abort(); controllers.clear();
    try { sessionStorage.removeItem(KEY); sessionStorage.removeItem(QUEUE_KEY); } catch { /* Optional storage. */ }
  }
  window.HEPAVisit = Object.freeze({ record,
    validationError(funnel,id) { return record('validation_error',fieldGroup(id || ''),funnel); },
    submitError(funnel,reason,status=0) { return record('submit_error',TARGETS.submit_error.includes(reason)?reason:'unknown',funnel,status); },
    submitSuccess(funnel,token) { return record('submit_success',funnel,funnel,0,token); }
  });
  window.addEventListener('hepa:analytics-consent',()=>granted()?start():stop());
  window.addEventListener('pagehide',()=>flush());
  document.addEventListener('visibilitychange',()=>{ if(document.hidden)flush(); else {lastTick=Date.now();viewForms();} });
  for (const name of ['pointerdown','keydown','touchstart']) document.addEventListener(name,()=>{lastInput=Date.now();},{passive:true});
  document.addEventListener('scroll',()=>{
    lastInput=Date.now(); viewForms();
    const height=document.documentElement.scrollHeight;
    if(height>innerHeight) for(const n of [25,50,75,90]) if((scrollY+innerHeight)/height*100>=n)record('scroll_depth',String(n));
  },{passive:true});
  document.addEventListener('click',event=>{
    if(!enabled || event.isTrusted!==true)return;
    const anchor=event.target.closest?.('a[href]');
    if(anchor) {
      const raw=anchor.getAttribute('href') || '';
      if(raw.startsWith('tel:'))record('cta_click','phone');
      else if(raw.startsWith('mailto:'))record('cta_click','email');
      else { try {
        const url=new URL(anchor.href,location.origin);
        if(url.origin===location.origin && url.hash==='#ajanlat')record('cta_click','callback','callback');
        if(url.origin===location.origin && url.pathname==='/lapszabaszat-ajanlatkeres.html')record('cta_click','cutting','cutting');
        if(url.hostname==='www.google.com' && url.pathname.startsWith('/maps/dir'))record('cta_click','directions');
      } catch { /* No arbitrary URL is recorded. */ } }
    }
    const category=event.target.closest?.('[data-category]')?.dataset.category;
    if(category && TARGETS.reference_view.includes(category))record('reference_view',category);
    if(event.target.closest?.('[data-lightbox], .reference-project button'))record('reference_view','showcase');
    if(event.target.closest?.('[data-flow], #add-item, #add-material, #add-edge-profile')) {record('form_view','cutting','cutting');record('form_start','cutting','cutting');}
  });
  document.addEventListener('input',event=>{
    if(event.isTrusted!==true)return;
    const form=event.target.closest?.('#quoteForm, #cutting-form'), funnel=funnelOf(form);
    if(funnel && event.target.name!=='company_website'){record('form_view',funnel,funnel);record('form_start',funnel,funnel);}
  });
  document.addEventListener('change',event=>{
    if(event.isTrusted!==true)return;
    const form=event.target.closest?.('#quoteForm, #cutting-form'), funnel=funnelOf(form);
    if(funnel && event.target.name!=='company_website'){record('form_view',funnel,funnel);record('form_start',funnel,funnel);}
  });
  document.addEventListener('invalid',event=>{const funnel=funnelOf(event.target.closest?.('form'));if(funnel)record('validation_error',fieldGroup(event.target.id),funnel);},true);
  document.addEventListener('toggle',event=>{
    const d=event.target;if(!d.open)return;
    record('details_open',d.matches?.('.callback-extra')?'optional':d.closest?.('.reference-project')?'project':d.closest?.('.reference-container')?'gallery':'faq');
  },true);
  window.addEventListener('error',event=>{
    const type={IMG:'image',SCRIPT:'script',LINK:'style'}[event.target?.tagName];
    if(type)record('resource_error',type);
    else if(event.target===window)record('resource_error','script');
  },true);
  window.addEventListener('unhandledrejection',()=>record('resource_error','script'));
  start();
})();
