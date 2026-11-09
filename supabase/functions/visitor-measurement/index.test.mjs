import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
const source=stripTypeScriptTypes(readFileSync(new URL('./index.ts',import.meta.url),'utf8').replace(/^import .*\n/,''));
const uuid='10000000-0000-4000-8000-000000000001',publicKey='sb_publishable_DPpJ2bkxAvoo6Xqp_gDi2g_oGRNIIbl';
const event={id:uuid,type:'page_view',target:'',funnel:'',value:0,sequence:1};
const batch={sessionToken:uuid,pageViewId:uuid,page:'/',source:'google_ads',campaignId:'24245353820',device:'mobile',isTest:true,events:[event]};
function app({user=true,claims={aal:'aal2',sub:'admin'},member=true,rpcError=false}={}){
  let handler;const calls=[];
  new Function('Deno','createClient',source)({env:{get:k=>({SUPABASE_URL:'https://example.invalid',SUPABASE_SERVICE_ROLE_KEY:'secret'})[k]},serve:f=>{handler=f;}},(url,key,options)=>{
    assert.equal(key,'secret');assert.deepEqual(options,{auth:{persistSession:false,autoRefreshToken:false}});
    return {auth:{getUser:async token=>({data:{user:user?{id:'admin'}:null},error:null}),getClaims:async()=>({data:{claims},error:null})},
      from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:member?{user_id:'admin'}:null,error:null})})})}),
      rpc:async(name,args)=>{calls.push({name,args});return {data:{summary:{}},error:rpcError?{message:'PRIVATE_DATABASE_ERROR'}:null};}};
  });
  return {calls,send:(body=batch,headers={})=>handler(new Request('https://example.invalid',{method:'POST',headers:{origin:'https://hepabutor.hu',apikey:publicKey,'content-type':'application/json',...headers},body:JSON.stringify(body)}))};
}
test('anonymous collection accepts only bounded whitelisted events and production origins',async()=>{
  const a=app();assert.equal((await a.send()).status,202);
  assert.equal((await a.send(batch,{origin:'https://attacker.invalid'})).status,403);
  assert.equal((await a.send(batch,{apikey:'bad'})).status,401);
  for(const bad of [{...batch,email:'PRIVATE'},{...batch,page:'/?phone=PRIVATE'},{...batch,campaignId:'PRIVATE'},
    {...batch,events:Array(21).fill(event)},{...batch,events:[{...event,target:'PRIVATE'}]},
    {...batch,events:[{...event,fieldValue:'PRIVATE'}]}, {...batch,events:[{...event,sequence:NaN}]},
    {...batch,events:[{...event,type:'submit_success',target:'callback',funnel:'callback'}]}])assert.equal((await a.send(bad)).status,400);
  assert.equal(a.calls.length,1);
});
test('report requires a valid authenticated admin with verified second-factor claim',async()=>{
  const body={action:'report',days:7,device:'all',source:'all'};
  const a=app();assert.equal((await a.send(body)).status,401);
  for(const options of [{user:false},{claims:{aal:'aal1',sub:'admin'}},{claims:{aal:'aal2',sub:'someone-else'}},{member:false}]){
    const denied=app(options);assert.ok([401,403].includes((await denied.send(body,{authorization:'Bearer jwt'})).status));assert.equal(denied.calls.length,0);
  }
  assert.equal((await a.send(body,{authorization:'Bearer verified-admin-token'})).status,200);
  assert.equal(a.calls[0].name,'get_visitor_measurement_report');
});
test('a public success report is only handed to the database verifier; internal failures stay private',async()=>{
  const a=app();const success={...batch,events:[{...event,type:'submit_success',target:'callback',funnel:'callback',submissionToken:uuid}]};
  assert.equal((await a.send(success)).status,202);assert.equal(a.calls[0].name,'record_visitor_measurement');
  const failed=app({rpcError:true});const response=await failed.send();assert.equal(response.status,503);assert.equal((await response.text()).includes('PRIVATE'),false);
});
