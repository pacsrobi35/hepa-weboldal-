import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import test from 'node:test';

const source=readFileSync(new URL('../visitor-measurement.js',import.meta.url),'utf8');
function storage(){const values=new Map(),operations=[];return {values,operations,getItem(k){operations.push(['get',k]);return values.get(k)||null;},setItem(k,v){operations.push(['set',k]);values.set(k,v);},removeItem(k){operations.push(['delete',k]);values.delete(k);}};}
function harness({consent=false,shared=storage(),url='https://hepabutor.hu/?gclid=PRIVATE_CLICK&utm_campaign=24245353820&utm_term=PRIVATE_SEARCH&phone=PRIVATE_PHONE',request=async()=>({ok:true})}={}){
  const requests=[],events={},winEvents={},intervals=[];let enabled=consent,now=Date.now();
  const form={id:'quoteForm',getBoundingClientRect:()=>({top:2000,bottom:2600,width:350,height:600})};
  const document={referrer:'https://www.google.com/search?q=PRIVATE_SEARCH',hidden:false,documentElement:{scrollHeight:6000},
    querySelector:()=>null,querySelectorAll:s=>s==='#quoteForm, #cutting-form'?[form]:[],
    addEventListener(n,f){(events[n]||=[]).push(f);}};
  const window={HEPAMarketing:{hasAnalyticsConsent:()=>enabled},addEventListener(n,f){(winEvents[n]||=[]).push(f);}};
  const location=new URL(url);
  class Clock extends Date{static now(){return now;}}
  vm.runInNewContext(source,{window,document,location,navigator:{webdriver:false},sessionStorage:shared,crypto:{randomUUID},Date:Clock,
    URL,innerHeight:844,scrollY:0,matchMedia:()=>({matches:true}),AbortController,
    setInterval:f=>{intervals.push(f);return 1;},clearInterval(){},setTimeout:()=>1,clearTimeout(){},
    fetch:(url,options)=>{requests.push({url,options,body:JSON.parse(options.body)});return request(url,options);}});
  return {window,requests,shared,form,
    consent(value){enabled=value;for(const f of winEvents['hepa:analytics-consent']||[])f();},
    event(n,target,extra={}){for(const f of events[n]||[])f({target,isTrusted:true,...extra});},
    tick(){now+=2000;for(const f of intervals)f();},advance(ms){now+=ms;},hide(){for(const f of winEvents.pagehide||[])f();}};
}
const settled=()=>new Promise(r=>setImmediate(r));

test('no statistics request or session storage before consent; prior actions are not replayed',async()=>{
  const app=harness();app.window.HEPAVisit.record('cta_click','phone');
  assert.equal(app.requests.length,0);assert.equal(app.shared.operations.length,0);
  app.consent(true);await settled();
  assert.deepEqual(app.requests.flatMap(r=>r.body.events.map(e=>e.type)),['page_view']);
});
test('source and campaign survive navigation; private query/referrer/form strings never enter payloads',async()=>{
  const app=harness({consent:true});await settled();
  app.event('input',{name:'customer_name',id:'customer_name',value:'PRIVATE_NAME',closest:()=>app.form});app.tick();await settled();
  const next=harness({consent:true,shared:app.shared,url:'https://hepabutor.hu/lapszabaszat.html'});await settled();
  assert.equal(next.requests[0].body.source,'google_ads');assert.equal(next.requests[0].body.campaignId,'24245353820');
  assert.equal(next.requests[0].body.sessionToken,app.requests[0].body.sessionToken);
  assert.notEqual(next.requests[0].body.pageViewId,app.requests[0].body.pageViewId);
  assert.ok(!JSON.stringify([...app.requests,...next.requests].map(r=>r.body)).includes('PRIVATE'));
  assert.equal(app.window.HEPAVisit.record('cta_click','PRIVATE_NAME'),false);
});
test('phone is only a click; a success requires its own UUID and funnel',async()=>{
  const app=harness({consent:true});await settled();
  app.window.HEPAVisit.record('cta_click','phone');await settled();
  assert.equal(app.window.HEPAVisit.submitSuccess('callback','not-a-uuid'),false);
  assert.ok(!app.requests.flatMap(r=>r.body.events).some(e=>e.type==='submit_success'));
  const token=randomUUID();app.window.HEPAVisit.submitSuccess('callback',token);await settled();
  assert.equal(app.requests.at(-1).body.events.at(-1).submissionToken,token);
  assert.equal(app.window.HEPAVisit.submitSuccess('callback',token),false);
});
test('withdrawal aborts a request, erases pending storage and ignores late replies',async()=>{
  let resolve;const app=harness({consent:true,request:()=>new Promise(r=>{resolve=r;})});
  const signal=app.requests[0].options.signal;app.consent(false);assert.equal(signal.aborted,true);
  assert.equal(app.shared.values.size,0);resolve({ok:true});await settled();assert.equal(app.shared.values.size,0);
  app.window.HEPAVisit.record('cta_click','phone');assert.equal(app.requests.length,1);
});
test('failed delivery is retried with identical event IDs and creates no new page-view event',async()=>{
  let ok=false;const app=harness({consent:true,request:async()=>({ok})});await settled();
  const id=app.requests[0].body.events[0].id;ok=true;app.tick();await settled();
  assert.equal(app.requests[1].body.events[0].id,id);assert.equal(app.requests[1].body.events.filter(e=>e.type==='page_view').length,1);
});
test('30 minutes of inactivity creates a new visit rather than a permanent user identifier',async()=>{
  const app=harness({consent:true});await settled();const id=app.requests[0].body.sessionToken;
  app.advance(1800001);app.window.HEPAVisit.record('cta_click','phone');await settled();
  assert.notEqual(app.requests.at(-1).body.sessionToken,id);assert.ok(app.requests.at(-1).body.events.some(e=>e.type==='page_view'));
});
test('a statistics-only grant records confirmed submissions without loading Google Ads',()=>{
  const consentSource=readFileSync(new URL('../marketing-consent.js',import.meta.url),'utf8');
  const nodes={},scripts=[],success=[];const make=()=>({listeners:{},hidden:false,classList:{add(){},remove(){}},setAttribute(){},focus(){},addEventListener(n,f){this.listeners[n]=f;},querySelector(s){return nodes[s]||=make();}});
  const document={currentScript:{hasAttribute:()=>false},documentElement:make(),createElement:make,querySelectorAll:()=>[],body:{appendChild(n){nodes.panel=n;}},head:{appendChild(n){scripts.push(n);}},cookie:''};
  const local=storage();const window={localStorage:local,sessionStorage:storage(),location:{hostname:'hepabutor.hu',pathname:'/'},addEventListener(){},dispatchEvent(){},HEPAVisit:{submitSuccess:(...args)=>success.push(args)}};
  vm.runInNewContext(consentSource,{window,document,URL,URLSearchParams,CustomEvent:class{}});
  nodes.panel.querySelector('[data-consent-statistics]').listeners.click();
  assert.equal(window.HEPAMarketing.hasAnalyticsConsent(),true);assert.equal(scripts.length,0);
  const token=randomUUID();window.HEPAMarketing.recordQuoteSubmission({requestMode:'callback',responseOk:true,ok:true,state:'ready',reference:'HEPA-000123',submissionToken:token});
  assert.deepEqual(success,[['callback',token]]);assert.equal(scripts.length,0);
});


test('visibility polling does not renew an idle visit; genuine interaction starts a new visit after the timeout',async()=>{
  const app=harness({consent:true});await settled();
  app.form.getBoundingClientRect=()=>({top:100,bottom:700,width:350,height:600});
  app.tick();await settled();
  const previous=JSON.parse(app.shared.values.get('hepa-visits-v1'));
  app.advance(1800001);app.tick();await settled();
  assert.equal(JSON.parse(app.shared.values.get('hepa-visits-v1')).lastActivity,previous.lastActivity);
  app.event('pointerdown',{});app.tick();await settled();
  assert.notEqual(JSON.parse(app.shared.values.get('hepa-visits-v1')).token,previous.token);
});
