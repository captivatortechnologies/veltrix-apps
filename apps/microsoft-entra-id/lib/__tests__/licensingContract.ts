import test from 'node:test'
import assert from 'node:assert/strict'
import { licensingHandlers } from '../licensing'
import { TOKEN, recordFetch, item, deployContext, rollbackContext, driftContext, healthContext, bodyOf, writeCalls, graphError } from './fakeGraph'
const ID='11111111-1111-1111-1111-111111111111',SKU='22222222-2222-2222-2222-222222222222',PLAN='33333333-3333-3333-3333-333333333333'
export function licensingContract(kind:'users'|'groups',handlers:ReturnType<typeof licensingHandlers>,getStatus:(ctx:any)=>Promise<any>){
 const target=(licenses:unknown=[])=>item('Pilot',{name:'Pilot',resourceId:ID,licenses:JSON.stringify(licenses)})
 const catalog={body:{value:[{skuId:SKU,servicePlans:[{servicePlanId:PLAN}]}]}}
 const state=(direct:boolean)=>({body:{id:ID,assignedLicenses:direct?[{skuId:SKU,disabledPlans:[]}]:[],licenseAssignmentStates:direct?[{skuId:SKU,disabledPlans:[],assignedByGroup:null}]:[]}})
 test(`${kind} licensing validate: requires explicit targets and an intentional license array`,()=>{
  assert.equal(handlers.validate(deployContext([target([{skuId:SKU}])])).valid,true)
  assert.equal(handlers.validate(deployContext([item('bad',{resourceId:ID,licenses:'not-json'})])).valid,false)
  assert.equal(handlers.validate(deployContext([target([{skuId:SKU},{skuId:SKU}])])).valid,false)
 })
 test(`${kind} licensing deploy: records direct prior state before requesting a change`,async()=>{
  const {calls,restore}=recordFetch([TOKEN,catalog,state(false),{body:{id:ID}}])
  try{
   const result=await handlers.deploy(deployContext([target([{skuId:SKU,disabledPlans:[PLAN]}])]))
   assert.equal(result.success,true,result.message);assert.deepEqual((result.rollbackData as any).entries[0].prior,[])
   assert.deepEqual(bodyOf(writeCalls(calls)[0]),{addLicenses:[{skuId:SKU,disabledPlans:[PLAN]}],removeLicenses:[]})
  }finally{restore()}
 })
 test(`${kind} licensing deploy: does not write when a target read fails`,async()=>{
  const {calls,restore}=recordFetch([TOKEN,catalog,graphError(403,'denied')])
  try{assert.equal((await handlers.deploy(deployContext([target([])]))).success,false);assert.equal(writeCalls(calls).length,0)}finally{restore()}
 })
 test(`${kind} licensing rollback: restores previous direct assignments`,async()=>{
  const {calls,restore}=recordFetch([TOKEN,state(false),{body:{id:ID}}])
  try{
   const result=await handlers.rollback(rollbackContext({entries:[{path:`/${kind}/${ID}`,name:'Pilot',prior:[{skuId:SKU,disabledPlans:[]}]}]}))
   assert.equal(result.success,true);assert.deepEqual(bodyOf(writeCalls(calls)[0]),{addLicenses:[{skuId:SKU,disabledPlans:[]}],removeLicenses:[]})
  }finally{restore()}
 })
 test(`${kind} licensing drift and health: detect missing assignments without mutation`,async()=>{
  const probe=recordFetch([TOKEN,state(false)])
  try{assert.equal((await handlers.driftDetect(driftContext([target([{skuId:SKU}])]))).hasDrift,true);assert.equal(writeCalls(probe.calls).length,0)}finally{probe.restore()}
  const second=recordFetch([TOKEN,state(false)])
  try{const context=healthContext();context.canvas.items=[target([{skuId:SKU}])];assert.equal((await handlers.healthCheck(context)).healthy,false)}finally{second.restore()}
 })
 test(`${kind} licensing getStatus: queries platform deployment history only`,async()=>{
  const probe=recordFetch([])
  try{assert.equal((await getStatus(deployContext([target()]))).deployed,false);assert.equal(probe.calls.length,0)}finally{probe.restore()}
 })
 if(kind==='users')test('user licensing: inherited assignments are never removed by direct reconciliation',async()=>{
  const inherited={body:{id:ID,assignedLicenses:[{skuId:SKU,disabledPlans:[]}],licenseAssignmentStates:[{skuId:SKU,disabledPlans:[],assignedByGroup:ID}]}}
  const probe=recordFetch([TOKEN,catalog,inherited])
  try{assert.equal((await handlers.deploy(deployContext([target([])]))).success,true);assert.equal(writeCalls(probe.calls).length,0)}finally{probe.restore()}
 })
}
