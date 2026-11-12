import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ENTRA_OPERATIONS } from '../operationDefinitions'
import { ENTRA_REPORTS } from '../reportDefinitions'
import { reportPath } from '../reports'
import { DECLARED_OPERATIONS } from './declaredOperationHandlers'
import { TOKEN, healthContext, recordFetch, writeCalls, bodyOf, graphError } from './fakeGraph'
const ID='11111111-1111-1111-1111-111111111111'
function paramsFor(def:(typeof ENTRA_OPERATIONS)[number]):Record<string,unknown>{
 const params:Record<string,unknown>={confirmation:def.id}
 for(const field of def.fields){
  params[field.key]=field.kind==='id'?ID:field.kind==='domain'?'example.test':field.kind==='segment'?'job-1':field.kind==='ids'?[ID]:field.kind==='enum'?field.choices![0]:field.kind==='boolean'?false:field.kind==='json'?field.key==='scheduleInfo'?{expiration:{type:'afterDuration',duration:'PT1H'}}:[{ruleId:ID,subjects:[{objectId:ID,objectTypeName:'User'}]}]:field.key==='invitedUserEmailAddress'?'guest@example.test':field.key==='inviteRedirectUrl'?'https://app.example.test':field.key==='directoryScopeId'?'/':'Pilot action'
 }
 if(def.id==='request-access-package-assignment')params.assignment={targetId:ID,assignmentPolicyId:ID,accessPackageId:ID}
 if(def.id==='request-catalog-resource')params.resource={originSystem:'AadGroup',originId:ID}
 return params
}
for(const def of ENTRA_OPERATIONS){
 const handler=DECLARED_OPERATIONS[def.id as keyof typeof DECLARED_OPERATIONS]
 test(`${def.id}: refuses unconfirmed actions without network access`,async()=>{
  const {calls,restore}=recordFetch([])
  try{assert.equal((await handler({...healthContext(),params:{}} as never)).ok,false);assert.equal(calls.length,0)}finally{restore()}
 })
 test(`${def.id}: sends only the declared method and endpoint after confirmation`,async()=>{
  const responses=[TOKEN,...(def.guard==='unverified-domain'?[{body:{id:'example.test',isInitial:false,isDefault:false,isVerified:false}}]:def.guard==='cloud-user'?[{body:{id:ID,onPremisesSyncEnabled:null}}]:[]),{status:200,body:{id:'result-id',secretText:'must-not-return',passwordProfile:{password:'must-not-return'}}}]
  const {calls,restore}=recordFetch(responses)
  try{
   const result=await handler({...healthContext(),params:paramsFor(def)} as never)
   assert.equal(result.ok,true,result.message)
   const writes=writeCalls(calls);assert.equal(writes.length,1);assert.equal(writes[0].method,def.method)
   assert.equal(writes[0].url.includes('{'),false);assert.equal(writes[0].url.includes('undefined'),false)
   assert.equal(JSON.stringify(result).includes('must-not-return'),false)
   if(def.bodyKind==='manager')assert.deepEqual(bodyOf(writes[0]),{'@odata.id':`https://graph.microsoft.com/v1.0/users/${ID}`})
   if(def.bodyKind==='subjects')assert.deepEqual(bodyOf(writes[0]),{subjects:[{id:ID}]})
  }finally{restore()}
 })
}
for(const def of ENTRA_REPORTS){
 const handler=DECLARED_OPERATIONS[('report-'+def.id) as keyof typeof DECLARED_OPERATIONS]
 test(`report-${def.id}: is read-only and returns only the report columns`,async()=>{
  const params=Object.fromEntries((def.parameters??[]).map(field=>[field.key,field.kind==='domain'?'example.test':field.kind==='segment'?'job-1':ID]))
  const row={id:ID,displayName:'Pilot',password:'never',unknown:'not selected',statusInfo:{password:'never',status:'ok'}}
  const {calls,restore}=recordFetch([TOKEN,{body:def.single?row:{value:[row]}}])
  try{
   const result=await handler({...healthContext(),params} as never)
   assert.equal(result.ok,true,result.message);assert.equal(writeCalls(calls).length,0)
   assert.equal(JSON.stringify(result).includes('never'),false);assert.equal(JSON.stringify(result).includes('not selected'),false)
  }finally{restore()}
 })
}

test('scoped reports reject missing/injected IDs and bound audit date ranges',()=>{
 const scoped=ENTRA_REPORTS.find(d=>d.id==='review-decisions')!
 assert.throws(()=>reportPath(scoped,{definitionId:'../other',instanceId:ID}))
 const log=ENTRA_REPORTS.find(d=>d.id==='sign-ins')!
 assert.throws(()=>reportPath(log,{from:'2020-01-01',to:'2026-01-01'}))
 assert.ok(reportPath(log,{},new Date('2026-11-12T00:00:00Z')).includes('$filter='))
})
test('read-only reports propagate denied access without returning an empty successful report',async()=>{
 const {restore}=recordFetch([TOKEN,graphError(403,'missing read permission')])
 try{const result=await DECLARED_OPERATIONS['report-users']({...healthContext(),params:{}} as never);assert.equal(result.ok,false);assert.match(result.message,/missing read permission/)}finally{restore()}
})
test('domain deletion refuses verified domains before any write',async()=>{
 const {calls,restore}=recordFetch([TOKEN,{body:{id:'example.test',isInitial:false,isDefault:false,isVerified:true}}])
 try{const result=await DECLARED_OPERATIONS['delete-unverified-domain']({...healthContext(),params:{confirmation:'delete-unverified-domain',domainId:'example.test'}} as never);assert.equal(result.ok,false);assert.equal(writeCalls(calls).length,0)}finally{restore()}
})
test('every operation and report has a declared permission gate in the manifest',()=>{
 const manifest=readFileSync('apps/microsoft-entra-id/manifest.yaml','utf8').replace(/\r\n/g,'\n')
 for(const definition of [...ENTRA_OPERATIONS,...ENTRA_REPORTS.map(d=>({...d,id:'report-'+d.id}))]){
  const start=manifest.indexOf(`  - id: ${definition.id}\n`)
  assert.ok(start>=0,definition.id)
  const block=manifest.slice(start,manifest.indexOf('\n  - id:',start+1)<0?manifest.length:manifest.indexOf('\n  - id:',start+1))
  assert.ok(block.includes('requiresPermission:'),definition.id)
 }
})


test('malformed entitlement payloads fail before authentication or mutation',async()=>{
 for(const [id,params] of [['request-access-package-assignment',{requestType:'adminAdd',assignment:[]}],['request-catalog-resource',{catalogId:ID,requestType:'adminAdd',resource:{originSystem:'AadGroup',originId:'../foreign'}}]] as const){
  const probe=recordFetch([])
  try{assert.equal((await DECLARED_OPERATIONS[id]({...healthContext(),params:{...params,confirmation:id}} as never)).ok,false);assert.equal(probe.calls.length,0)}finally{probe.restore()}
 }
})

test('user license state uses the application-supported user fields rather than delegated licenseDetails',async()=>{
 const row={id:ID,assignedLicenses:[{skuId:ID,disabledPlans:[]}],licenseAssignmentStates:[{skuId:ID,assignedByGroup:null,state:'Active'}],assignedPlans:[]}
 const probe=recordFetch([TOKEN,{body:row}])
 try{
  const result=await DECLARED_OPERATIONS['report-user-license-details']({...healthContext(),params:{userId:ID}} as never)
  assert.equal(result.ok,true,result.message)
  assert.deepEqual(result.data?.items,[row]);assert.equal(probe.calls.some(c=>c.url.includes('/licenseDetails')),false)
 }finally{probe.restore()}
})
