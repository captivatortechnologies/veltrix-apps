import type { CanvasSnapshot, DeployContext, DeployResult, DriftContext, DriftResult, HealthCheckContext, PipelineContext, RollbackContext, RollbackResult, ValidationResult } from '@veltrixsecops/app-sdk'
import { buildGraphClient, graphErrorMessage, parseJson, readGraphSettings, resolveGraphCredential, MISSING_CREDENTIAL_MESSAGE, type GraphClient } from './graph'
import { canonical } from './managedResources'

interface License { skuId:string; disabledPlans:string[] }
interface LicenseTarget { name:string; resourceId:string; licenses:License[] }
interface LicenseEntry { path:string; name:string; prior:License[] }
const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function specs(canvas:CanvasSnapshot):LicenseTarget[]{
 return (canvas.items??canvas.sections??[]).map(item=>{
  const f=item.fields??{},raw=typeof f.licenses==='string'?JSON.parse(f.licenses):f.licenses
  if(!Array.isArray(raw))throw new Error('Licenses must be a JSON array; use [] to remove direct assignments')
  const licenses=raw.map(value=>{
   if(!value||typeof value!=='object'||!GUID.test(String(value.skuId)))throw new Error('Every license needs a SKU GUID')
   if(Object.keys(value).some(k=>!['skuId','disabledPlans'].includes(k)))throw new Error('Only skuId and disabledPlans are supported')
   const disabled=value.disabledPlans??[]
   if(!Array.isArray(disabled)||disabled.some(p=>typeof p!=='string'||!GUID.test(p)))throw new Error('disabledPlans must be an array of service-plan GUIDs')
   return {skuId:String(value.skuId).toLowerCase(),disabledPlans:[...new Set(disabled.map(p=>String(p).toLowerCase()))].sort()}
  })
  if(new Set(licenses.map(l=>l.skuId)).size!==licenses.length)throw new Error('Each SKU may only occur once per target')
  return {name:String(f.name??item.name??''),resourceId:String(f.resourceId??''),licenses}
 })
}
function normalized(licenses:License[]):License[]{return licenses.map(l=>({skuId:l.skuId.toLowerCase(),disabledPlans:[...l.disabledPlans].map(p=>p.toLowerCase()).sort()})).sort((a,b)=>a.skuId.localeCompare(b.skuId))}
async function current(client:GraphClient,path:string,kind:'users'|'groups'):Promise<License[]>{
 const response=await client.get(`${path}?$select=id,assignedLicenses${kind==='users'?',licenseAssignmentStates':''}`)
 if(!response.ok)throw new Error(`Cannot read license assignments: ${graphErrorMessage(response)}`)
 const value=parseJson<{assignedLicenses?:License[];licenseAssignmentStates?:Array<{skuId:string;disabledPlans?:string[];assignedByGroup?:string|null}>}>(response.body)
 if(!Array.isArray(value?.assignedLicenses))throw new Error('License response is incomplete')
 if(kind==='groups')return normalized(value.assignedLicenses)
 if(!Array.isArray(value.licenseAssignmentStates))throw new Error('Direct versus inherited license state is unavailable; refusing to remove licenses')
 return normalized(value.licenseAssignmentStates.filter(s=>!s.assignedByGroup).map(s=>({skuId:s.skuId,disabledPlans:s.disabledPlans??[]})))
}
function delta(before:License[],after:License[]){
 return {addLicenses:after.filter(a=>!before.some(b=>b.skuId===a.skuId && canonical(b.disabledPlans)===canonical(a.disabledPlans))),removeLicenses:before.filter(b=>!after.some(a=>a.skuId===b.skuId)).map(b=>b.skuId)}
}
function graph(ctx:PipelineContext){
 const settings=readGraphSettings(ctx.settings??{}),credential=resolveGraphCredential(ctx.credential??null,settings,ctx.identity)
 if(!credential)throw new Error(settings.configurationError??MISSING_CREDENTIAL_MESSAGE)
 return buildGraphClient(credential,settings)
}
export function licensingHandlers(kind:'users'|'groups'){
 const validate=(ctx:PipelineContext):ValidationResult=>{
  const errors:ValidationResult['errors']=[]
  try{
   const targets=specs(ctx.canvas)
   if(!targets.length)throw new Error('Declare at least one license target')
   if(targets.some(t=>!GUID.test(t.resourceId)))throw new Error('Each target must use an existing object GUID')
   if(new Set(targets.map(t=>t.resourceId.toLowerCase())).size!==targets.length)throw new Error('A license target may only be declared once')
  }catch(error){errors.push({field:'licenses',code:'invalid_licenses',message:error instanceof Error?error.message:'Invalid license configuration'})}
  return {valid:!errors.length,errors,warnings:[{field:'licenses',code:'license_reconciliation',message:kind==='users'?'Manages direct assignments only; inherited group licenses are preserved. Review removals before deployment.':'License propagation to group members is asynchronous. Review service-plan effects before deployment.'}]}
 }
 const deploy=async(ctx:DeployContext):Promise<DeployResult>=>{
  const entries:LicenseEntry[]=[]
  try{
   const validation=validate(ctx);if(!validation.valid)throw new Error(validation.errors[0].message)
   const client=graph(ctx),targets=specs(ctx.canvas)
   const catalog=await client.getAll<{skuId:string;servicePlans:Array<{servicePlanId:string}>}>('/subscribedSkus')
   if(!catalog.ok||catalog.truncated)throw new Error('Cannot read the complete subscribed SKU catalog')
   const prepared=[]
   for(const target of targets){
    for(const license of target.licenses){
     const sku=catalog.items.find(s=>s.skuId.toLowerCase()===license.skuId)
     if(!sku)throw new Error(`${target.name}: unknown subscribed SKU ${license.skuId}`)
     if(license.disabledPlans.some(id=>!sku.servicePlans?.some(p=>p.servicePlanId.toLowerCase()===id)))throw new Error(`${target.name}: disabled service plan does not belong to the selected SKU`)
    }
    const path=`/${kind}/${encodeURIComponent(target.resourceId)}`
    prepared.push({target,path,prior:await current(client,path,kind)})
   }
   for(const {target,path,prior} of prepared){
    if(canonical(prior)===canonical(normalized(target.licenses)))continue
    entries.push({path,name:target.name,prior})
    const response=await client.post(`${path}/assignLicense`,delta(prior,normalized(target.licenses)))
    if(!response.ok)throw new Error(`${target.name}: ${graphErrorMessage(response)}`)
   }
   return {success:true,message:'License assignment request accepted; verify asynchronous propagation and assignment errors',rollbackData:{entries}}
  }catch(error){return {success:false,message:error instanceof Error?error.message:'License deployment failed',rollbackData:{entries}}}
 }
 const rollback=async(ctx:RollbackContext):Promise<RollbackResult>=>{
  const failures:string[]=[]
  try{
   const client=graph(ctx),entries=(ctx.rollbackData as {entries?:LicenseEntry[]}|undefined)?.entries??[]
   for(const entry of [...entries].reverse()){
    if(!new RegExp(`^/${kind}/[0-9a-f-]{36}$`,'i').test(entry.path)){failures.push('Invalid license rollback target');continue}
    const live=await current(client,entry.path,kind)
    const response=await client.post(`${entry.path}/assignLicense`,delta(live,entry.prior))
    if(!response.ok)failures.push(`${entry.name}: ${graphErrorMessage(response)}`)
   }
  }catch(error){failures.push(error instanceof Error?error.message:'License rollback failed')}
  return {success:!failures.length,message:failures.length?failures.join('; '):'Prior direct license assignments requested; verify propagation'}
 }
 const driftDetect=async(ctx:DriftContext):Promise<DriftResult>=>{
  const diffs:DriftResult['diffs']=[]
  try{
   const client=graph(ctx)
   for(const target of specs(ctx.deployedConfig)){
    const live=await current(client,`/${kind}/${encodeURIComponent(target.resourceId)}`,kind)
    const wanted=normalized(target.licenses)
    if(canonical(live)!==canonical(wanted))diffs.push({field:`${target.name}.licenses`,expected:wanted,actual:live,severity:'warning'})
   }
   return {hasDrift:!!diffs.length,diffs}
  }catch{return {hasDrift:!!diffs.length,diffs,checked:false}}
 }
 const healthCheck=async(ctx:HealthCheckContext)=>{
  const result=await driftDetect({...ctx,deployedConfig:ctx.canvas})
  const passed=(ctx.canvas.items??ctx.canvas.sections??[]).length>0 && result.checked!==false && !result.hasDrift
  return {healthy:passed,score:passed?100:0,checks:[{name:'license-assignments',passed,message:passed?'Direct license assignments match':'License assignments differ, are pending propagation, or could not be read'}]}
 }
 return {validate,deploy,rollback,driftDetect,healthCheck}
}
