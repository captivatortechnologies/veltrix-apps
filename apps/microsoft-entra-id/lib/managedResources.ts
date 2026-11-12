import type { CanvasSnapshot, ConfigStatus, DeployContext, DeployResult, DriftContext, DriftResult, HealthCheckContext, HealthCheckResult, PipelineContext, RollbackContext, RollbackResult, ValidationResult } from '@veltrixsecops/app-sdk'
import { buildGraphClient, graphErrorMessage, parseJson, readGraphSettings, resolveGraphCredential, MISSING_CREDENTIAL_MESSAGE, type GraphClient } from './graph'
import { resourceDefinition, type ResourceDefinition } from './resourceDefinitions'

export interface ManagedSpec { itemId?:string; name:string; parentId:string; resourceId:string; properties:Record<string,unknown> }
export interface ManagedEntry { parentId?:string; itemId?:string; name:string; path:string; collection:string; id?:string; action:'created'|'updated'|'unchanged'|'uncertain'; prior?:Record<string,unknown> }
const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SEGMENT=/^[A-Za-z0-9][A-Za-z0-9._@-]{0,511}$/
const DOMAIN=/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i
const FORBIDDEN=/^(password|passwordProfile|client[_-]?secret|secretText|private[_-]?key(?:Pem)?|access[_-]?token|refresh[_-]?token|fileData|passwordCredentials|keyCredentials)$/i
export function canonical(value:unknown):string {
  if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`
  if(value && typeof value==='object')return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
export function assertSafeProperties(value:unknown):asserts value is Record<string,unknown> {
  if(!value || typeof value!=='object' || Array.isArray(value))throw new Error('Managed properties must be a JSON object')
  const walk=(node:unknown,depth:number)=>{
    if(depth>20)throw new Error('Managed properties exceed the maximum nesting depth')
    if(!node || typeof node!=='object')return
    for(const [key,item] of Object.entries(node)){
      if(['__proto__','constructor','prototype'].includes(key)||(FORBIDDEN.test(key)&&!(key==='accessToken'&&Array.isArray(item))))throw new Error(`Property ${key} is not allowed in configuration; store secret material in the vault`)
      walk(item,depth+1)
    }
  }
  walk(value,0)
}
export function extractManagedSpecs(canvas:CanvasSnapshot):ManagedSpec[] {
  return (canvas.items??canvas.sections??[]).map(item=>{
    const f=item.fields??{}
    const raw=f.properties??'{}'
    const properties=typeof raw==='string'?JSON.parse(raw):raw
    assertSafeProperties(properties)
    return {itemId:item.id,name:String(f.name??item.name??'').trim(),parentId:String(f.parentId??'').trim(),resourceId:String(f.resourceId??'').trim(),properties}
  })
}
export function validateManaged(def:ResourceDefinition,ctx:PipelineContext):ValidationResult {
  const errors:ValidationResult['errors']=[],warnings:ValidationResult['warnings']=[]
  let specs:ManagedSpec[]=[]
  try{specs=extractManagedSpecs(ctx.canvas)}catch(error){errors.push({field:'properties',code:'invalid_properties',message:error instanceof Error?error.message:'Invalid managed properties'})}
  const seen=new Set<string>()
  if(!specs.length && !errors.length)errors.push({field:'items',code:'required',message:'Add at least one managed resource'})
  for(const [i,spec] of specs.entries()){
    const fail=(field:string,message:string)=>errors.push({field:`items[${i}].${field}`,code:'invalid_configuration',message})
    if(!spec.name)fail('name','A descriptive name is required')
    if(def.parent && !(def.parent==='guid'?GUID:def.parent==='domain'?DOMAIN:SEGMENT).test(spec.parentId))fail('parentId',`A valid ${def.parent==='guid'?'parent object ID':'domain name'} is required`)
    if(spec.resourceId && !SEGMENT.test(spec.resourceId))fail('resourceId','Resource ID contains unsupported characters')
    if(!def.create && !def.singleton && !spec.resourceId)fail('resourceId','Select an existing resource ID; this configuration does not create accounts or devices')
    if(def.groupKind && !spec.resourceId){
      const p=spec.properties,types=Array.isArray(p.groupTypes)?p.groupTypes:[]
      if(p.mailEnabled!==(def.groupKind==='m365') || p.securityEnabled!==(def.groupKind!=='m365'))fail('properties','Group mailEnabled and securityEnabled must match the selected group kind')
      if(def.groupKind==='dynamic' && (!types.includes('DynamicMembership') || !p.membershipRule))fail('properties','Dynamic groups require a membership rule and DynamicMembership group type')
      if(def.groupKind==='m365' && !types.includes('Unified'))fail('properties','Microsoft 365 groups require Unified group type')
      if(def.groupKind==='role' && (p.isAssignableToRole!==true || types.includes('DynamicMembership') || p.visibility && p.visibility!=='Private'))fail('properties','Role-assignable groups require isAssignableToRole, assigned membership and Private visibility')
    }
    if(spec.properties.membershipRuleProcessingState!==undefined && !['On','Paused'].includes(String(spec.properties.membershipRuleProcessingState)))fail('properties','Membership rule processing state must be On or Paused')
    const unknown=Object.keys(spec.properties).filter(key=>!def.fields.includes(key))
    if(unknown.length)fail('properties',`Unsupported managed fields: ${unknown.join(', ')}. Allowed fields: ${def.fields.join(', ')}`)
    if(!Object.keys(spec.properties).length)fail('properties','Declare at least one field to manage')
    if(!spec.resourceId && def.create)for(const field of def.required??[])if(spec.properties[field]===undefined || spec.properties[field]==='')fail('properties',`${field} is required when creating a resource`)
    const key=`${spec.parentId}/${def.singleton?'singleton':spec.resourceId || def.identity.map(k=>canonical(spec.properties[k])).join('|')}`
    if(seen.has(key))fail('resourceId','The same resource is declared more than once')
    seen.add(key)
    if(def.id==='application-federated-credentials'){
      const p=spec.properties
      if(p.issuer!==undefined){try{if(new URL(String(p.issuer)).protocol!=='https:')throw new Error()}catch{fail('properties','Federated issuer must be an HTTPS URL')}}
      if(p.audiences!==undefined && (!Array.isArray(p.audiences)||!p.audiences.length||p.audiences.some(a=>typeof a!=='string')))fail('properties','Audiences must be a non-empty string array')
    }
    if(def.id==='service-principal-app-role-assignments'){
      for(const key of ['principalId','resourceId','appRoleId'])if(!GUID.test(String(spec.properties[key]??'')))fail('properties',`${key} must be a GUID`)
      if(String(spec.properties.resourceId)!==spec.parentId)fail('properties','The resourceId must equal the parent service-principal object ID')
    }
    if(spec.properties.accountEnabled!==undefined && typeof spec.properties.accountEnabled!=='boolean')fail('properties','accountEnabled must be boolean')
    if(spec.properties.usageLocation!==undefined && !/^[A-Z]{2}$/.test(String(spec.properties.usageLocation)))fail('properties','usageLocation must be a two-letter uppercase country code')
  }
  if(def.id==='provisioning-job-schemas')warnings.push({field:'properties',code:'full_schema_replace',message:'Provisioning schema deployment replaces the supplied schema collections. Review mappings and pilot the job before enabling provisioning.'})
  return {valid:!errors.length,errors,warnings}
}
function collectionPath(def:ResourceDefinition,spec:ManagedSpec):string { return def.collection.replace('{parent}',encodeURIComponent(spec.parentId)) }
function resourcePath(def:ResourceDefinition,spec:ManagedSpec,id:string):string { return `${collectionPath(def,spec)}${def.singleton?'':`/${encodeURIComponent(id)}`}${def.suffix??''}` }
export function managedProjection(live:Record<string,unknown>,desired:Record<string,unknown>):Record<string,unknown> {
  return Object.fromEntries(Object.entries(desired).map(([key,want])=>{
    if(key==='@odata.type')return [key,want]
    const actual=live[key]
    return [key,want && typeof want==='object' && !Array.isArray(want) && actual && typeof actual==='object' && !Array.isArray(actual)
      ? managedProjection(actual as Record<string,unknown>,want as Record<string,unknown>) : actual??null]
  }))
}
/** PATCH object merging preserves unmanaged sibling fields; PUT snapshots the complete declared collections. */
export function mergeManaged(live:Record<string,unknown>,desired:Record<string,unknown>):Record<string,unknown> {
  return Object.fromEntries(Object.entries(desired).map(([key,want])=>{
    const old=live[key]
    if(want && typeof want==='object' && !Array.isArray(want) && old && typeof old==='object' && !Array.isArray(old))
      return [key,{...old as Record<string,unknown>,...mergeManaged(old as Record<string,unknown>,want as Record<string,unknown>)}]
    return [key,want]
  }))
}
function clientFrom(ctx:PipelineContext):GraphClient {
  const settings=readGraphSettings(ctx.settings??{})
  if(settings.configurationError)throw new Error(settings.configurationError)
  const credential=resolveGraphCredential(ctx.credential??null,settings,ctx.identity)
  if(!credential)throw new Error(MISSING_CREDENTIAL_MESSAGE)
  return buildGraphClient(credential,settings)
}
async function identify(def:ResourceDefinition,spec:ManagedSpec,client:GraphClient,prior:ManagedEntry[]):Promise<{path:string;collection:string;id?:string;live:Record<string,unknown>|null}> {
  const collection=collectionPath(def,spec)
  const remembered=prior.find(e=>e.itemId && e.itemId===spec.itemId && e.collection===collection)
  const id=spec.resourceId||remembered?.id
  if(def.singleton||id){
    const path=resourcePath(def,spec,id??'')
    const keys=[...new Set(['id',...Object.keys(spec.properties),...(def.protectSynced?['onPremisesSyncEnabled']:[]),...(def.groupKind?['groupTypes','securityEnabled','mailEnabled','isAssignableToRole']:[])])]
    const response=await client.get(def.suffix?path:`${path}${def.query??'?$select='+keys.join(',')}`)
    if(response.status===404 && !spec.resourceId && !def.singleton && def.create)return {path,collection,live:null}
    if(!response.ok)throw new Error(`${spec.name}: unable to read current resource: ${graphErrorMessage(response)}`)
    const live=parseJson<Record<string,unknown>>(response.body)
    if(!live || Array.isArray(live) || typeof live!=='object')throw new Error(`${spec.name}: invalid resource response`)
    return {path,collection,id:String(def.suffix ? id ?? '' : live.id??id??''),live}
  }
  const listed=await client.getAll<Record<string,unknown>>(collection+(def.query??''))
  if(!listed.ok || listed.truncated)throw new Error(`${spec.name}: resource listing failed or was incomplete; refusing to infer absence`)
  const matches=listed.items.filter(item=>def.identity.every(key=>canonical(managedProjection(item,{[key]:spec.properties[key]})[key])===canonical(spec.properties[key])))
  if(matches.length>1)throw new Error(`${spec.name}: ambiguous resource identity; select an explicit ID`)
  const live=matches[0]??null
  if(live && typeof live.id!=='string')throw new Error(`${spec.name}: existing resource has no ID`)
  if(!live && !def.create)throw new Error(`${spec.name}: existing resource is required`)
  // Read the full requested managed fields rather than trusting collection defaults.
  if(live)return identify(def,{...spec,resourceId:String(live.id)},client,prior)
  return {path:collection,collection,live:null}
}

export function managedHandlers(id:string){
  const def=resourceDefinition(id)
  const validate=(ctx:PipelineContext)=>validateManaged(def,ctx)
  const deploy=async(ctx:DeployContext):Promise<DeployResult>=>{
    const entries:ManagedEntry[]=[]
    try{
      const validation=validate(ctx)
      if(!validation.valid)return {success:false,message:validation.errors.map(e=>e.message).join('; '),rollbackData:{entries}}
      const specs=extractManagedSpecs(ctx.canvas),client=clientFrom(ctx)
      const latest=await ctx.platform.getLatestDeployment(ctx.canvas.canvasId,{status:'SUCCEEDED'})
      const prior=(latest?.rollbackData as {entries?:ManagedEntry[]}|undefined)?.entries??[]
      const prepared=[]
      // Finish ALL reads/guards before the first mutation.
      for(const spec of specs){
        const target=await identify(def,spec,client,prior)
        if(def.protectSynced && target.live?.onPremisesSyncEnabled===true)throw new Error(`${spec.name}: this object is synchronized from on-premises; manage its source of authority`)
        if(def.groupKind && target.live){
          const live=target.live,types=Array.isArray(live.groupTypes)?live.groupTypes:[]
          const match=def.groupKind==='m365'?types.includes('Unified'):def.groupKind==='role'?live.isAssignableToRole===true:types.includes('DynamicMembership')&&!types.includes('Unified')&&live.isAssignableToRole!==true
          if(!match)throw new Error(`${spec.name}: the existing group kind does not match this configuration type`)
        }
        for(const key of def.immutable??[])if(target.live && spec.properties[key]!==undefined && canonical(target.live[key])!==canonical(spec.properties[key]))throw new Error(`${spec.name}: ${key} is immutable`)
        if(target.live && def.update===false && canonical(managedProjection(target.live,spec.properties))!==canonical(spec.properties))throw new Error(`${spec.name}: this assignment is immutable; create a separate assignment and explicitly revoke the old one`)
        prepared.push({spec,target})
      }
      for(const {spec,target} of prepared){
        const desired={...spec.properties,...(def.publicType?{'@odata.type':def.publicType}:{})}
        if(target.live){
          const writable=Object.fromEntries(Object.entries(desired).filter(([key])=>!def.immutable?.includes(key)))
          const prior=managedProjection(target.live,writable)
          const entry:ManagedEntry={parentId:spec.parentId,itemId:spec.itemId,name:spec.name,path:target.path,collection:target.collection,id:target.id,action:'unchanged'}
          entries.push(entry)
          if(canonical(prior)===canonical(writable))continue
          if(!def.update)continue
          entry.action='updated';entry.prior=prior // Persist BEFORE a potentially committed write.
          const response=await client.request(def.update,target.path,mergeManaged(target.live,writable))
          if(!response.ok)throw new Error(`${spec.name}: ${graphErrorMessage(response)}`)
        }else{
          const entry:ManagedEntry={parentId:spec.parentId,itemId:spec.itemId,name:spec.name,path:target.path,collection:target.collection,action:'uncertain'}
          entries.push(entry)
          const response=await client.post(target.collection,desired)
          if(!response.ok)throw new Error(`${spec.name}: ${graphErrorMessage(response)}`)
          const created=parseJson<{id?:string}>(response.body)
          if(!created?.id || typeof created.id!=='string' || !SEGMENT.test(created.id))throw new Error(`${spec.name}: create response has no resource ID; inspect live state before retrying`)
          entry.action='created';entry.id=created.id;entry.path=resourcePath(def,spec,created.id)
        }
      }
      return {success:true,message:`Applied ${entries.length} ${def.name} configuration(s)`,rollbackData:{entries}}
    }catch(error){return {success:false,message:error instanceof Error?error.message:'Entra resource deployment failed',rollbackData:{entries}}}
  }
  const rollback=async(ctx:RollbackContext):Promise<RollbackResult>=>{
    const failures:string[]=[]
    try{
      const client=clientFrom(ctx)
      const entries=(ctx.rollbackData as {entries?:ManagedEntry[]}|undefined)?.entries??[]
      for(const entry of [...entries].reverse()){
        if(entry.action==='unchanged')continue
        // Rollback data must be bound to this descriptor, not an arbitrary Graph URL.
        const spec={parentId:entry.parentId??'',name:entry.name,resourceId:entry.id??'',properties:{}}
        if(def.parent && !(def.parent==='guid'?GUID:def.parent==='domain'?DOMAIN:SEGMENT).test(spec.parentId) ||
           entry.collection!==collectionPath(def,spec) ||
           entry.action!=='uncertain' && entry.path!==resourcePath(def,spec,entry.id??'') ||
           entry.id && !SEGMENT.test(entry.id)) {failures.push(`${entry.name}: invalid rollback resource path`);continue}
        if(entry.prior){
          assertSafeProperties(entry.prior)
          if(Object.keys(entry.prior).some(k=>!def.fields.includes(k) && !(k==='@odata.type' && entry.prior![k]===def.publicType)))throw new Error('Rollback contains unmanaged fields')
        }
        if(entry.action==='uncertain' || !entry.id && !def.singleton){failures.push(`${entry.name}: mutation outcome or identity is unresolved; inspect live state`);continue}
        if(entry.action==='created'){
          if(def.rollbackCreate==='deactivate'){
            const result=await client.patch(entry.path,{isActive:false})
            failures.push(result.ok?`${entry.name}: created allowed value remains deactivated; the API does not support deletion`:`${entry.name}: ${graphErrorMessage(result)}`)
            continue
          }
          const result=await client.delete(entry.path)
          if(!result.ok && result.status!==404)failures.push(`${entry.name}: ${graphErrorMessage(result)}`)
        }else if(entry.prior && def.update){
          // Read current nested objects so rollback does not erase unmanaged sibling keys.
          const current=await client.get(entry.path)
          const live=parseJson<Record<string,unknown>>(current.body)
          if(!current.ok||!live){failures.push(`${entry.name}: restore target unreadable (HTTP ${current.status})`);continue}
          const result=await client.request(def.update,entry.path,mergeManaged(live,entry.prior))
          if(!result.ok)failures.push(`${entry.name}: ${graphErrorMessage(result)}`)
        }else failures.push(`${entry.name}: prior managed values unavailable`)
      }
    }catch(error){failures.push(error instanceof Error?error.message:'Rollback failed')}
    return {success:!failures.length,message:failures.length?`Rollback incomplete: ${failures.join('; ')}`:`Restored ${def.name} managed configuration`}
  }
  const driftDetect=async(ctx:DriftContext):Promise<DriftResult>=>{
    const diffs:DriftResult['diffs']=[]
    try{
      const client=clientFrom(ctx),specs=extractManagedSpecs(ctx.deployedConfig)
      const latest=await ctx.platform.getLatestDeployment(ctx.canvas.canvasId,{status:'SUCCEEDED'})
      const prior=(latest?.rollbackData as {entries?:ManagedEntry[]}|undefined)?.entries??[]
      for(const spec of specs){
        let target
        try{target=await identify(def,spec,client,prior)}catch(error){
          // Distinguish known absence from unverified reads using a direct ID read.
          const stored=prior.find(e=>e.itemId===spec.itemId && e.collection===collectionPath(def,spec))
          const id=spec.resourceId||stored?.id
          if(id){const response=await client.get(resourcePath(def,spec,id));if(response.status===404){diffs.push({field:spec.name,expected:'present',actual:'absent',severity:'critical'});continue}}
          throw error
        }
        if(!target.live){diffs.push({field:spec.name,expected:'present',actual:'absent',severity:'critical'});continue}
        for(const [key,wanted] of Object.entries(spec.properties)){
          const actual=managedProjection(target.live,{[key]:wanted})[key]
          if(canonical(actual)!==canonical(wanted))diffs.push({field:`${spec.name}.${key}`,expected:wanted,actual,severity:'warning'})
        }
      }
      return {hasDrift:!!diffs.length,diffs}
    }catch{return {hasDrift:!!diffs.length,diffs,checked:false}}
  }
  const healthCheck=async(ctx:HealthCheckContext):Promise<HealthCheckResult>=>{
    const result=await driftDetect({...ctx,deployedConfig:ctx.canvas})
    const hasItems=(ctx.canvas.items??ctx.canvas.sections??[]).length>0
    const passed=hasItems && result.checked!==false && !result.hasDrift
    return {healthy:passed,score:passed?100:0,checks:[{name:'managed-resources',passed,message:!hasItems?'No managed resources supplied for verification':result.checked===false?'Managed-resource verification incomplete':result.hasDrift?`Managed fields differ: ${result.diffs.map(d=>d.field).join(', ')}`:'Managed resources and fields verified'}]}
  }
  const getStatus=async(ctx:PipelineContext):Promise<ConfigStatus>=>{
    const last=await ctx.platform.getLatestDeployment(ctx.canvas.canvasId,{status:'SUCCEEDED'})
    return {deployed:!!last,lastDeployedAt:last?.completedAt??'',version:String(ctx.canvas.version??''),componentStatuses:[]}
  }
  return {validate,deploy,rollback,driftDetect,healthCheck,getStatus}
}
