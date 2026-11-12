import test from 'node:test'
import assert from 'node:assert/strict'
import type { ResourceDefinition } from '../resourceDefinitions'
import { managedHandlers, canonical, type ManagedEntry } from '../managedResources'
import { TOKEN, recordFetch, item, deployContext, rollbackContext, driftContext, healthContext, writeCalls, bodyOf, graphError } from './fakeGraph'
const ID='11111111-1111-1111-1111-111111111111'
function changed(value:unknown):unknown {
 if(typeof value==='boolean')return !value
 if(typeof value==='number')return value+1
 if(typeof value==='string')return 'prior-value'
 if(Array.isArray(value))return [{prior:true}]
 if(value && typeof value==='object'){const [key,child]=Object.entries(value).find(([key])=>!key.startsWith('@'))??Object.entries(value)[0];return {...value,[key]:changed(child)}}
 return 'prior-value'
}
export function managedContract(def:ResourceDefinition,handlers:ReturnType<typeof managedHandlers>){
 const existingId=typeof def.sample.id==='string'?def.sample.id:ID
 const parentId=def.parent==='domain'?'example.test':def.parent==='segment'?'Security_Classification':def.id==='service-principal-app-role-assignments'?String(def.sample.resourceId):ID
 const fields={name:'Pilot resource',parentId,resourceId:def.singleton?'':existingId,properties:JSON.stringify(def.sample)}
 const prior={id:existingId,...def.sample}
 const mutable=Object.keys(def.sample).find(key=>!def.immutable?.includes(key))!
 const before={...prior,...(mutable?{[mutable]:changed(def.sample[mutable])}:{})}
 test(`${def.id}: validate rejects unknown fields, secret material and invalid parents`,()=>{
  assert.equal(handlers.validate(deployContext([item('Pilot',fields)])).valid,true)
  for(const properties of ['{"passwordProfile":{"password":"never-store"}}','{"unmanaged":true}','[]','not-json'])assert.equal(handlers.validate(deployContext([item('Pilot',{...fields,properties})])).valid,false)
  if(def.parent)assert.equal(handlers.validate(deployContext([item('Pilot',{...fields,parentId:'../foreign'})])).valid,false)
 })
 test(`${def.id}: deploy fails closed before writes when a preflight read is denied`,async()=>{
  const {calls,restore}=recordFetch([TOKEN,graphError(403,'denied')])
  try{const result=await handlers.deploy(deployContext([item('Pilot',fields)]));assert.equal(result.success,false);assert.equal(writeCalls(calls).length,0)}finally{restore()}
 })
 test(`${def.id}: deploy snapshots live managed state before writing and preserves unrelated fields`,async()=>{
  const live={...before,unmanaged:'keep'}
  const {calls,restore}=recordFetch([TOKEN,{body:live},{status:204,body:''}])
  try{
   const result=await handlers.deploy(deployContext([item('Pilot',fields)]))
   if(def.update===false){assert.equal(result.success,false);assert.equal(writeCalls(calls).length,0);return}
   assert.equal(result.success,true,result.message)
   const entries=(result.rollbackData as {entries:ManagedEntry[]}).entries
   assert.equal(entries[0].action,'updated');assert.equal(canonical(entries[0].prior?.[mutable]),canonical(before[mutable as keyof typeof before]))
   const sent=bodyOf(writeCalls(calls)[0])!;assert.equal('unmanaged' in sent,false)
  }finally{restore()}
 })
 test(`${def.id}: drift detects managed field changes and health never labels them healthy`,async()=>{
  const {restore}=recordFetch([TOKEN,{body:before}])
  try{const result=await handlers.driftDetect(driftContext([item('Pilot',fields)]));assert.equal(result.hasDrift,true)}finally{restore()}
  const probe=recordFetch([TOKEN,{body:before}])
  try{const ctx=healthContext();ctx.canvas.items=[item('Pilot',fields)];assert.equal((await handlers.healthCheck(ctx)).healthy,false)}finally{probe.restore()}
 })
 test(`${def.id}: drift is unchecked after failed reads and getStatus reads deployment history only`,async()=>{
  const {calls,restore}=recordFetch([TOKEN,graphError(403,'denied'),graphError(403,'denied')])
  try{assert.equal((await handlers.driftDetect(driftContext([item('Pilot',fields)]))).checked,false);assert.equal(writeCalls(calls).length,0)}finally{restore()}
  const probe=recordFetch([])
  try{assert.equal((await handlers.getStatus(deployContext([item('Pilot',fields)]))).deployed,false);assert.equal(probe.calls.length,0)}finally{probe.restore()}
 })
 test(`${def.id}: rollback does not accept a path outside the declared resource`,async()=>{
  const {calls,restore}=recordFetch([])
  try{const result=await handlers.rollback(rollbackContext({entries:[{action:'updated',id:ID,parentId,path:'/users/foreign/authentication',collection:'/users',prior:{displayName:'bad'},name:'invalid'}]}));assert.equal(result.success,false);assert.equal(writeCalls(calls).length,0)}finally{restore()}
 })
 if(def.update)test(`${def.id}: rollback refuses to report success when the restore target is missing`,async()=>{
  const deployment=recordFetch([TOKEN,{body:before},{status:204,body:''}])
  let entries:ManagedEntry[]=[]
  try{const result=await handlers.deploy(deployContext([item('Pilot',fields)]));entries=(result.rollbackData as {entries:ManagedEntry[]}).entries}finally{deployment.restore()}
  const probe=recordFetch([TOKEN,{status:404,body:{error:{message:'missing'}}}])
  try{assert.equal((await handlers.rollback(rollbackContext({entries}))).success,false)}finally{probe.restore()}
 })
 if(def.create)test(`${def.id}: creates with a stable identity and rollback deletes only the returned ID`,async()=>{
  const {calls,restore}=recordFetch([TOKEN,{body:{value:[]}},{status:201,body:{id:existingId}}])
  let entries:ManagedEntry[]=[]
  try{
   const result=await handlers.deploy(deployContext([item('Pilot',{...fields,resourceId:''})]));assert.equal(result.success,true,result.message)
   entries=(result.rollbackData as {entries:ManagedEntry[]}).entries;assert.equal(entries[0].id,existingId)
   assert.equal(writeCalls(calls)[0].method,'POST')
  }finally{restore()}
  const probe=recordFetch([TOKEN,{status:204,body:''}])
  try{assert.equal((await handlers.rollback(rollbackContext({entries}))).success,!def.rollbackCreate);assert.equal(writeCalls(probe.calls)[0].method,def.rollbackCreate?'PATCH':'DELETE')}finally{probe.restore()}
 })
}
