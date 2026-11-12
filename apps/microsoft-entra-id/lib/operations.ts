import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { ENTRA_OPERATIONS } from './operationDefinitions'
import { assertSafeProperties } from './managedResources'
import { buildGraphClient, graphErrorMessage, parseJson, readGraphSettings, resolveGraphCredential, type GraphIdentity } from './graph'
export interface EntraOperationContext {appId:string;customerId:string;operationId?:string;credential:CredentialRef|null;settings:Record<string,unknown>;params?:Record<string,unknown>;identity?:GraphIdentity}
const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DOMAIN=/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i
export function operationHandler(id:string){
 return async(ctx:EntraOperationContext):Promise<{ok:boolean;message:string;data?:Record<string,unknown>}>=>{
  try{
   const def=ENTRA_OPERATIONS.find(d=>d.id===id)
   if(!def)throw new Error('Unknown Entra operation')
   const raw=ctx.params??{}
   if(raw.confirmation!==id)throw new Error(`Confirm the target and effects by entering ${id}`)
   const values:Record<string,unknown>={}
   for(const field of def.fields){
    let value=raw[field.key]
    if(value===undefined || value===''){
     if(field.required)throw new Error(`${field.label} is required`)
     continue
    }
    if(field.kind==='json'||field.kind==='ids')value=typeof value==='string'?JSON.parse(value):value
    if(field.kind==='id'&&!GUID.test(String(value)))throw new Error(`${field.label} must be an object GUID`)
    if(field.kind==='domain'&&!DOMAIN.test(String(value)))throw new Error(`${field.label} must be a domain DNS name`)
    if(field.kind==='segment'&&!/^[A-Za-z0-9][A-Za-z0-9._-]{0,511}$/.test(String(value)))throw new Error(`${field.label} is invalid`)
    if(field.kind==='boolean'&&typeof value!=='boolean')throw new Error(`${field.label} must be boolean`)
    if(field.kind==='enum'&&!field.choices?.includes(String(value)))throw new Error(`${field.label} must be one of ${field.choices?.join(', ')}`)
    if(field.kind==='ids'&&(!Array.isArray(value)||!value.length||value.length>100||value.some(v=>typeof v!=='string'||!GUID.test(v))))throw new Error(`${field.label} needs 1–100 object GUIDs`)
    if(field.kind==='string'&&(typeof value!=='string'||value.length>4096))throw new Error(`${field.label} must be text of at most 4096 characters`)
    assertSafeProperties({value})
    values[field.key]=value
   }
   if(id==='invite-guest'){
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(values.invitedUserEmailAddress)))throw new Error('Guest email is invalid')
    if(new URL(String(values.inviteRedirectUrl)).protocol!=='https:')throw new Error('Redirect URL must use HTTPS')
   }
   const object=(value:unknown,label:string):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error(`${label} must be a JSON object`);return value as Record<string,unknown>}
   if(id==='request-access-package-assignment'){
    const assignment=object(values.assignment,'Assignment')
    for(const key of values.requestType==='adminRemove'?['id']:values.requestType==='adminAdd'?['targetId','assignmentPolicyId','accessPackageId']:['id'])if(!GUID.test(String(assignment[key]??'')))throw new Error(`Assignment ${key} must be an object GUID`)
   }
   if(id==='request-catalog-resource'){
    const resource=object(values.resource,'Resource')
    if(!['AadGroup','AadApplication','SharePointOnline'].includes(String(resource.originSystem)))throw new Error('Resource originSystem must be AadGroup, AadApplication or SharePointOnline')
    if(typeof resource.originId!=='string'||!resource.originId.trim())throw new Error('Resource originId is required')
    if(resource.originSystem!=='SharePointOnline'&&!GUID.test(resource.originId))throw new Error('Directory resource originId must be an object GUID')
   }
   if(values.scheduleInfo!==undefined)object(values.scheduleInfo,'Schedule information')
   if(values.action && values.action!=='adminRemove' && !values.scheduleInfo)throw new Error('A schedule is required for assignment and update requests')
   const path=def.path.replace(/\{(\w+)\}/g,(_match,key:string)=>{
    if(typeof values[key]!=='string')throw new Error(`Missing path parameter ${key}`)
    return encodeURIComponent(values[key] as string)
   })
   const settings=readGraphSettings(ctx.settings??{})
   const credential=resolveGraphCredential(ctx.credential,settings,ctx.identity)
   if(!credential)throw new Error(settings.configurationError??'Select a usable saved credential and configure its tenant')
   const client=buildGraphClient(credential,settings)
   if(def.guard){
    const response=await client.get(def.guard==='unverified-domain'?`/domains/${encodeURIComponent(String(values.domainId))}?$select=id,isInitial,isDefault,isVerified`:`/users/${encodeURIComponent(String(values.userId))}?$select=id,onPremisesSyncEnabled`)
    const value=parseJson<Record<string,unknown>>(response.body)
    if(!response.ok||!value)throw new Error('Cannot verify the target before this operation')
    if(def.guard==='unverified-domain'&&(value.isInitial!==false||value.isDefault!==false||value.isVerified!==false))throw new Error('Only explicitly unverified, nondefault, noninitial domains can be removed by this operation')
    if(def.guard==='cloud-user'&&value.onPremisesSyncEnabled!==null&&value.onPremisesSyncEnabled!==false)throw new Error('The user source of authority could not be verified as cloud-managed')
   }
   let body:Record<string,unknown>={...def.constants,...Object.fromEntries((def.bodyFields??[]).filter(k=>values[k]!==undefined).map(k=>[k,values[k]]))}
   if(def.bodyKind==='manager')body={'@odata.id':`https://graph.microsoft.com/v1.0/users/${values.managerId}`}
   if(def.bodyKind==='directory-object')body={'@odata.id':`https://graph.microsoft.com/v1.0/directoryObjects/${values.objectId}`}
   if(def.bodyKind==='catalog')body={...body,catalog:{id:values.catalogId}}
   if(def.bodyKind==='subjects')body={subjects:(values.userIds as string[]).map(id=>({id}))}
   if(id==='invite-guest'&&body.sendInvitationMessage===undefined)body.sendInvitationMessage=false
   const response=await client.request(def.method,path,def.method==='DELETE'?undefined:body)
   if(!response.ok)return {ok:false,message:`${def.name} failed (HTTP ${response.status}): ${graphErrorMessage(response)}`}
   const parsed=parseJson<{id?:string;status?:string;invitedUser?:{id?:string}}>(response.body)
   // Never return a raw vendor response: credential-bearing operations must use a vault workflow.
   const data={...(parsed?.id?{id:parsed.id}:{}),...(parsed?.status?{status:parsed.status}:{}),...(parsed?.invitedUser?.id?{userId:parsed.invitedUser.id}:{})}
   return {ok:true,message:`${def.name} request accepted. Verify the resulting state in Reports; asynchronous work may still be pending.`,data}
  }catch(error){return {ok:false,message:error instanceof Error?error.message:'Entra operation failed'}}
 }
}
