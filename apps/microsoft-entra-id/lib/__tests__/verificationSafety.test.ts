import test from 'node:test'
import assert from 'node:assert/strict'
import { GraphClient, readGraphSettings, resolveGraphCredential } from '../graph'
import { verifyManagedConfiguration } from '../verification'
import testConnection from '../../handlers/testConnection'
import { TOKEN, collection, healthContext, item, recordFetch, notFound } from './fakeGraph'

test('sovereign requests translate only Graph reference URLs in mutation bodies',async()=>{
 const {calls,restore}=recordFetch([TOKEN,{status:204,body:''}])
 try {
  const client=new GraphClient({cred:{tenantId:'tenant',clientId:'app',clientSecret:'secret',cloud:'us-gov'},timeoutMs:1000})
  await client.post('/groups/group/members/$ref',{'@odata.id':'https://graph.microsoft.com/v1.0/directoryObjects/principal',description:'https://graph.microsoft.com/v1.0/unrelated-text'})
  const sent=JSON.parse(String(calls[1].body))
  assert.equal(sent['@odata.id'],'https://graph.microsoft.us/v1.0/directoryObjects/principal')
  assert.equal(sent.description,'https://graph.microsoft.com/v1.0/unrelated-text')
 }finally{restore()}
})

test('malformed tenant overrides cannot silently fall back to the installation tenant',()=>{
 for(const connection_tenants of ['not-json','[]','{"connection":{"tenantId":123}}','{"connection":{"tenantId":""}}']) {
  const settings=readGraphSettings({tenant_id:'fallback',connection_tenants})
  assert.ok(settings.configurationError)
  assert.equal(resolveGraphCredential(healthContext().credential!,settings),null)
 }
})

test('tracked resource deletion cannot be hidden by a same-name replacement',async()=>{
 const ctx=healthContext();ctx.configTypeId='groups';ctx.canvas.items=[item('Ops',{name:'Ops'})]
 ctx.platform.getLatestDeployment=async()=>({rollbackData:{entries:[{name:'Ops',id:'original-id'}]}} as never)
 const {calls,restore}=recordFetch([TOKEN,notFound()]);let compared=false
 try {
  const result=await verifyManagedConfiguration(ctx,[{name:'connectivity',passed:true,message:'reachable'}],async()=>{compared=true;return {hasDrift:false,diffs:[]}})
  assert.equal(result.healthy,false);assert.equal(compared,false)
  assert.ok(calls[1].url.includes('/groups/original-id?'))
 }finally{restore()}
})

test('verification exceptions and incomplete comparisons never report healthy',async()=>{
 const ctx=healthContext();ctx.canvas.items=[item('Ops',{name:'Ops'})]
 const result=await verifyManagedConfiguration(ctx,[{name:'connectivity',passed:true,message:'reachable'}],async()=>{throw new Error('read failed')})
 assert.equal(result.healthy,false)
})

test('connection test rejects organization identity mismatch and malformed successful responses',async()=>{
 for(const response of [collection([{id:'22222222-2222-2222-2222-222222222222',displayName:'Other'}]),collection([])]) {
  const {restore}=recordFetch([TOKEN,response])
  try {
   const result=await testConnection({...healthContext(),settings:{tenant_id:'11111111-1111-1111-1111-111111111111'},endpoint:null} as never)
   assert.equal(result.ok,false)
  }finally{restore()}
 }
})

test('connection test preserves organization success while exposing selected-feature failure',async()=>{
 const {restore}=recordFetch([TOKEN,collection([{id:'tenant-id',displayName:'Intended'}]),{status:403,body:{error:{message:'denied'}}}])
 try {
  const result=await testConnection({...healthContext(),settings:{tenant_id:'tenant-id',readiness_features:'groups'},endpoint:null} as never)
  assert.equal(result.ok,false);assert.match(result.message,/Selected feature checks failed/)
  assert.ok(result.details?.some(d=>d.includes('Group.Read.All')))
 }finally{restore()}
})
