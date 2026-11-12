import test from 'node:test'
import assert from 'node:assert/strict'
import {buildPolicyBody, type ResolvedTargets} from '../../config-types/conditional-access-policies/deploy'
import validatePolicy,{extractPolicySpecs} from '../../config-types/conditional-access-policies/validate'
import deployMethod from '../../config-types/authentication-methods-policy/deploy'
import rollbackMethod from '../../config-types/authentication-methods-policy/rollback'
import {managedHandlers} from '../managedResources'
import {TOKEN,recordFetch,item,deployContext,rollbackContext,writeCalls,bodyOf,graphError} from './fakeGraph'
const ID='11111111-1111-1111-1111-111111111111'

test('advanced CA conditions retain base targets and add risk, filters and session controls',()=>{
 const spec=extractPolicySpecs(deployContext([item('Pilot',{name:'Pilot',includeGroups:[ID],includeApps:['Office365'],builtInControls:['mfa'],advancedConditions:JSON.stringify({signInRiskLevels:['high'],devices:{deviceFilter:{mode:'exclude',rule:'device.isCompliant -eq True'}},applications:{excludeApplications:[ID]}}),sessionControls:JSON.stringify({signInFrequency:{value:1,type:'hours',isEnabled:true}})})]).canvas)[0]
 const resolved={includeUsers:[],excludeUsers:[],includeGroups:[ID],excludeGroups:[],includeRoles:[],excludeRoles:[],includeLocations:[],excludeLocations:[],termsOfUse:[],authenticationStrengthId:null} as unknown as ResolvedTargets
 const body=buildPolicyBody(spec,resolved) as any
 assert.deepEqual(body.conditions.users.includeGroups,[ID]);assert.deepEqual(body.conditions.applications.includeApplications,['Office365'])
 assert.deepEqual(body.conditions.applications.excludeApplications,[ID]);assert.deepEqual(body.conditions.signInRiskLevels,['high']);assert.equal(body.sessionControls.signInFrequency.value,1)
 assert.equal('sessionControls' in buildPolicyBody({...spec,sessionControls:undefined},resolved),false)
 assert.equal(buildPolicyBody({...spec,sessionControls:null},resolved).sessionControls,null)
})

test('method advanced configuration preserves unmanaged nested settings during deploy and rollback',async()=>{
 const configuration={featureSettings:{displayLocationInformationRequiredState:{state:'enabled'}}}
 const before={id:'microsoftAuthenticator',state:'disabled',featureSettings:{displayLocationInformationRequiredState:{state:'disabled',includeTarget:{id:'all_users',targetType:'group'}},displayAppInformationRequiredState:{state:'enabled'}}}
 const probe=recordFetch([TOKEN,{body:before},{status:204,body:''}]);let rollbackData:unknown
 try{
  const result=await deployMethod(deployContext([item('Pilot',{method:'microsoftAuthenticator',state:'enabled',configuration:JSON.stringify(configuration)})]))
  assert.equal(result.success,true,result.message);rollbackData=result.rollbackData
  const body=bodyOf(writeCalls(probe.calls)[0]) as any
  assert.equal(body.featureSettings.displayLocationInformationRequiredState.state,'enabled');assert.deepEqual(body.featureSettings.displayLocationInformationRequiredState.includeTarget,before.featureSettings.displayLocationInformationRequiredState.includeTarget)
  assert.equal(body.featureSettings.displayAppInformationRequiredState.state,'enabled')
 }finally{probe.restore()}
 const undo=recordFetch([TOKEN,{body:{...before,featureSettings:{...before.featureSettings,displayAppInformationRequiredState:{state:'disabled'}}}},{status:204,body:''}])
 try{
  assert.equal((await rollbackMethod(rollbackContext(rollbackData))).success,true)
  const body=bodyOf(writeCalls(undo.calls)[0]) as any
  assert.equal(body.featureSettings.displayLocationInformationRequiredState.state,'disabled');assert.equal(body.featureSettings.displayAppInformationRequiredState.state,'disabled')
 }finally{undo.restore()}
})

test('resource engine completes every preflight before issuing any mutation',async()=>{
 const handlers=managedHandlers('directory-user-profiles')
 const probe=recordFetch([TOKEN,{body:{id:ID,displayName:'Old',onPremisesSyncEnabled:null}},graphError(403,'second target denied')])
 try{
  const result=await handlers.deploy(deployContext([item('One',{name:'One',resourceId:ID,properties:'{"displayName":"New"}'}),item('Two',{name:'Two',resourceId:'22222222-2222-2222-2222-222222222222',properties:'{"displayName":"New"}'})]))
  assert.equal(result.success,false);assert.equal(writeCalls(probe.calls).length,0)
 }finally{probe.restore()}
})

test('resource engine refuses changes to synchronized users and mismatched group kinds',async()=>{
 for(const [kind,live,properties] of [['directory-user-profiles',{id:ID,onPremisesSyncEnabled:true},{displayName:'New'}],['microsoft365-groups',{id:ID,groupTypes:[],mailEnabled:false,securityEnabled:true},{displayName:'New'}]] as const){
  const probe=recordFetch([TOKEN,{body:live}])
  try{assert.equal((await managedHandlers(kind).deploy(deployContext([item('Pilot',{name:'Pilot',resourceId:ID,properties:JSON.stringify(properties)})]))).success,false);assert.equal(writeCalls(probe.calls).length,0)}finally{probe.restore()}
 }
})


test('workload CA policies use direct service principals and reject mixed user/MFA targeting',()=>{
 const fields={name:'Workload',includeAllApps:true,builtInControls:['block'],advancedConditions:JSON.stringify({clientApplications:{includeServicePrincipals:[ID]},servicePrincipalRiskLevels:['high']})}
 const ctx=deployContext([item('Workload',fields)])
 assert.equal(validatePolicy(ctx).valid,true)
 const spec=extractPolicySpecs(ctx.canvas)[0]
 const resolved={includeUsers:[],excludeUsers:[],includeGroups:[],excludeGroups:[],includeRoles:[],excludeRoles:[],includeLocations:[],excludeLocations:[],termsOfUse:[],authenticationStrengthId:null} as unknown as ResolvedTargets
 const body=buildPolicyBody(spec,resolved) as any
 assert.equal(body.conditions.users,null);assert.equal('clientAppTypes' in body.conditions,false)
 assert.deepEqual(body.conditions.clientApplications.includeServicePrincipals,[ID])
 assert.equal(validatePolicy(deployContext([item('Mixed',{...fields,includeAllUsers:true})])).valid,false)
 assert.equal(validatePolicy(deployContext([item('MFA',{...fields,builtInControls:['mfa']})])).valid,false)
 const broad={...fields,state:'enabled',advancedConditions:JSON.stringify({clientApplications:{includeServicePrincipals:['ServicePrincipalsInMyTenant']}})}
 assert.equal(validatePolicy(deployContext([item('Broad',broad)])).valid,false)
})
