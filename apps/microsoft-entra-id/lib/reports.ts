import type { AppRouteContext } from '@veltrixsecops/app-sdk'
import type { FastifyInstance } from 'fastify'
import { ENTRA_REPORTS, type ReportDefinition } from './reportDefinitions'
import { buildGraphClient, graphErrorMessage, parseJson, readGraphSettings, resolveGraphCredential } from './graph'

export function reportPath(def:ReportDefinition,query:Record<string,unknown>,now=new Date()):string {
 const values:Record<string,string>={}
 for(const field of def.parameters??[]){
  const value=String(query[field.key]??'')
  const pattern=field.kind==='id'?/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i:field.kind==='domain'?/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i:/^[A-Za-z0-9][A-Za-z0-9._-]{0,511}$/
  if(!pattern.test(value))throw new Error(`Provide a valid ${field.label}`)
  values[field.key]=value
 }
 let path=def.path.replace(/\{(\w+)\}/g,(_match,key:string)=>encodeURIComponent(values[key]))
 if(def.timeField){
  const from=new Date(String(query.from??new Date(now.getTime()-86_400_000).toISOString()))
  const to=new Date(String(query.to??now.toISOString()))
  if(!Number.isFinite(from.getTime())||!Number.isFinite(to.getTime())||to<=from||to.getTime()-from.getTime()>90*86_400_000)throw new Error('Choose an increasing date range of at most 90 days')
  path+=`${path.includes('?')?'&':'?'}$filter=${encodeURIComponent(`${def.timeField} ge ${from.toISOString()} and ${def.timeField} le ${to.toISOString()}`)}`
 }
 return path
}
export function safeReportRow(row:Record<string,unknown>,columns:string[]):Record<string,unknown>{
 const clean=(value:unknown):unknown=>Array.isArray(value)?value.map(clean):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([key])=>!/^(password|passwordProfile|secretText|clientSecret|accessToken|refreshToken|privateKey)$/i.test(key)).map(([key,item])=>[key,clean(item)])):value
 return Object.fromEntries(columns.filter(key=>key in row).map(key=>[key,clean(row[key])]))
}
export function registerReports(fastify:FastifyInstance,ctx:AppRouteContext){
 for(const def of ENTRA_REPORTS){
  fastify.get(`/reports/${def.id}`,{
   preHandler:[ctx.hasPermission(def.resource,'read')],
   handler:async(request,reply)=>{
    const customerId=(request as any).user?.customerId
    if(!customerId)return reply.status(401).send({error:'Authentication required'})
    const query=(request.query??{}) as Record<string,unknown>
    let path:string
    try{path=reportPath(def,query)}catch(error){return reply.status(400).send({error:error instanceof Error?error.message:'Invalid report parameters'})}
    const connectionId=String(query.connectionId??'')
    if(!/^[A-Za-z0-9_-]{1,200}$/.test(connectionId))return reply.status(400).send({error:'Select a saved connection'})
    const connection=await ctx.resolveConnection(customerId,connectionId)
    if(!connection)return reply.status(404).send({error:'Connection is unavailable in the current tenant'})
    const installation=await ctx.db.appInstallation.findFirst({where:{app:{appId:ctx.appId},customerId,enabled:true}})
    const settings=readGraphSettings((installation?.settings??{}) as Record<string,unknown>)
    const credential=resolveGraphCredential(connection,settings)
    if(!credential)return reply.status(400).send({error:settings.configurationError??'Configure the connection tenant and a usable credential'})
    const client=buildGraphClient(credential,settings)
    if(def.single){
     const response=await client.get(path)
     if(!response.ok)return reply.status(502).send({error:graphErrorMessage(response)})
     const row=parseJson<Record<string,unknown>>(response.body)
     if(!row)return reply.status(502).send({error:'Invalid report response'})
     return reply.send({items:[safeReportRow(row,def.columns)],columns:def.columns,truncated:false})
    }
    const result=await client.getAll<Record<string,unknown>>(path,2)
    if(!result.ok)return reply.status(502).send({error:result.lastError?graphErrorMessage(result.lastError):'Report read failed'})
    return reply.send({items:result.items.slice(0,200).map(row=>safeReportRow(row,def.columns)),columns:def.columns,truncated:result.truncated||result.items.length>200})
   },
  })
 }
}
