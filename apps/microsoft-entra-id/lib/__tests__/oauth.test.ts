import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {readGraphSettings,resolveGraphCredential,buildGraphClient,normalizeGraphCloud} from '../graph'
import register from '../../server/index'
import testConnection from '../../handlers/testConnection'
import {recordFetch} from './fakeGraph'
const A='11111111-1111-1111-1111-111111111111',B='22222222-2222-2222-2222-222222222222'

test('OAuth manifest enables the platform consent flow without requiring a manual tenant or secret',()=>{
 const manifest=readFileSync('apps/microsoft-entra-id/manifest.yaml','utf8')
 assert.match(manifest,/provider: entra-oidc-consent/)
 assert.match(manifest,/label: Integrate with Microsoft \(OAuth\)/)
 assert.match(manifest,/tenantId: "connection-map:connection_tenants"/)
 assert.match(manifest,/brokered: true/)
 assert.equal(manifest.includes('tenantId: "setting:tenant_id"'),false)
})

test('two OAuth connections resolve independently without changing the manual tenant fallback',async()=>{
 const settings=readGraphSettings({tenant_id:'manual.example',connection_tenants:JSON.stringify({first:{tenantId:A,cloud:'commercial'},second:{tenantId:B,cloud:'gcc-high'}})})
 const requests:Array<Record<string,unknown>>=[]
 const identity={getAccessToken:async(input:Record<string,unknown>)=>{requests.push(input);return 'broker-token'}}
 const one=resolveGraphCredential({id:'first',name:'First',username:'connector'} as never,settings,identity)!
 const two=resolveGraphCredential({id:'second',name:'Second',username:'connector'} as never,settings,identity)!
 assert.equal(one.tenantId,A);assert.equal(two.tenantId,B);assert.equal(two.cloud,'us-gov')
 const probe=recordFetch([{body:{value:[]}},{body:{value:[]}}])
 try{
  assert.equal((await buildGraphClient(one,settings).get('/organization')).ok,true)
  assert.equal((await buildGraphClient(two,settings).get('/organization')).ok,true)
  assert.deepEqual(requests,[{tenantId:A,resource:'https://graph.microsoft.com',cloud:'global'},{tenantId:B,resource:'https://graph.microsoft.us',cloud:'us-gov'}])
  assert.equal(probe.calls.some(call=>call.url.includes('/oauth2/')),false)
 }finally{probe.restore()}
 const manual=resolveGraphCredential({id:'manual',name:'Manual',username:'own-app',password:'own-secret'} as never,settings)!
 assert.equal(manual.tenantId,'manual.example');assert.equal(manual.clientSecret,'own-secret')
})

test('an OAuth connection works without the installation fallback tenant',()=>{
 const settings=readGraphSettings({connection_tenants:{only:{tenantId:A,cloud:'dod'}}})
 const identity={getAccessToken:async()=> 'token'}
 const connection=resolveGraphCredential({id:'only',name:'OAuth',username:'connector'} as never,settings,identity)!
 assert.equal(connection.tenantId,A);assert.equal(connection.cloud,'us-gov-dod')
 assert.equal(resolveGraphCredential({id:'unbound',name:'Unbound'} as never,settings,identity),null)
 for(const [input,wanted] of [['commercial','global'],['gcc','global'],['gcc-high','us-gov'],['dod','us-gov-dod'],['china','china']])assert.equal(normalizeGraphCloud(input),wanted)
})


test('OAuth report API resolves a request-bound broker without a customer secret',async()=>{
 const routes=new Map<string,any>(),bound:string[]=[]
 const ctx={appId:'microsoft-entra-id',manifest:{permissions:{app:[{resource:'conditional-access-policies',actions:['read']}]},pipeline:{configurationTypes:[]}},
  hasPermission:()=>async()=>undefined,
  resolveConnection:async(customerId:string,id:string)=>{assert.equal(customerId,'customer-1');assert.equal(id,'oauth-connection');return {id,name:'OAuth',username:'connector'}},
  identityForConnection:(id:string)=>{bound.push(id);return {getAccessToken:async()=> 'broker-token'}},
  db:{appInstallation:{findFirst:async()=>({settings:{connection_tenants:{'oauth-connection':{tenantId:A,cloud:'global'}}}})}}}
 await register({get:(path:string,options:unknown)=>routes.set(path,options)} as never,ctx as never)
 const response={statusCode:200,payload:undefined as any,status(value:number){this.statusCode=value;return this},send(value:unknown){this.payload=value;return this}}
 const probe=recordFetch([{body:{value:[{id:'user',displayName:'Pilot',secretText:'hidden'}]}}])
 try{
  await routes.get('/reports/users').handler({user:{customerId:'customer-1'},query:{connectionId:'oauth-connection'}},response)
  assert.equal(response.statusCode,200);assert.deepEqual(bound,['oauth-connection'])
  assert.deepEqual(response.payload.items,[{id:'user',displayName:'Pilot'}])
  assert.equal(probe.calls.some(call=>call.url.includes('/oauth2/')),false)
 }finally{probe.restore()}
})


test('OAuth connection errors point to consent and reconnection rather than a customer secret',async()=>{
 const probe=recordFetch([{status:403,body:{error:{message:'Denied'}}}])
 try{
  const result=await testConnection({appId:'microsoft-entra-id',customerId:'customer-1',credential:{id:'oauth',name:'OAuth',username:'connector'} as never,endpoint:null,component:null,connectivity:null,identity:{getAccessToken:async()=> 'broker-token'},settings:{connection_tenants:{oauth:{tenantId:A,cloud:'global'}}}})
  assert.equal(result.ok,false);assert.match(result.message,/OAuth connector/);assert.match(result.message,/admin consent/);assert.equal(result.message.includes('client secret'),false)
 }finally{probe.restore()}
})
