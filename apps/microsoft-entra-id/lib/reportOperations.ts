import type { EntraOperationContext } from './operations'
import { ENTRA_REPORTS } from './reportDefinitions'
import { reportPath, safeReportRow } from './reports'
import { buildGraphClient, graphErrorMessage, parseJson, readGraphSettings, resolveGraphCredential } from './graph'
export function reportOperationHandler(id:string){
 return async(ctx:EntraOperationContext)=>{
  try{
   const def=ENTRA_REPORTS.find(d=>d.id===id)
   if(!def)throw new Error('Unknown report')
   const path=reportPath(def,ctx.params??{})
   const settings=readGraphSettings(ctx.settings??{}),credential=resolveGraphCredential(ctx.credential,settings,ctx.identity)
   if(!credential)throw new Error(settings.configurationError??'Select a usable saved credential and configure its tenant')
   const client=buildGraphClient(credential,settings)
   if(def.single){
    const response=await client.get(path)
    if(!response.ok)throw new Error(graphErrorMessage(response))
    const row=parseJson<Record<string,unknown>>(response.body)
    if(!row||typeof row!=='object'||Array.isArray(row)||!row.id)throw new Error('Invalid report response')
    return {ok:true,message:'Read-only report loaded',data:{items:[safeReportRow(row,def.columns)],columns:def.columns,truncated:false}}
   }
   const result=await client.getAll<Record<string,unknown>>(path,2)
   if(!result.ok)throw new Error(result.lastError?graphErrorMessage(result.lastError):'Report read failed')
   return {ok:true,message:'Read-only report loaded',data:{items:result.items.slice(0,200).map(row=>safeReportRow(row,def.columns)),columns:def.columns,truncated:result.truncated||result.items.length>200}}
  }catch(error){return {ok:false,message:error instanceof Error?error.message:'Unable to load report'}}
 }
}
