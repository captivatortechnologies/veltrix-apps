import React,{useState} from 'react'
import { runOperation } from '@veltrixsecops/app-sdk/client'
import { Button,Card,CardBody,Input,Select } from '@veltrixsecops/app-sdk/ui'
import { ENTRA_REPORTS } from '../../lib/reportDefinitions'
import { useEntraConnections } from '../hooks/useEntraConnections'
interface ReportData {items:Record<string,unknown>[];columns:string[];truncated:boolean}
const display=(value:unknown)=>value===undefined||value===null?'—':typeof value==='object'?JSON.stringify(value):String(value)
export default function ReportsPage(){
 const {connections,error}=useEntraConnections()
 const [reportId,setReportId]=useState(ENTRA_REPORTS[0].id),[credentialId,setCredentialId]=useState('')
 const [params,setParams]=useState<Record<string,string>>({}),[data,setData]=useState<ReportData|null>(null)
 const [message,setMessage]=useState<string|null>(null),[busy,setBusy]=useState(false)
 const definition=ENTRA_REPORTS.find(report=>report.id===reportId)!
 return <Card><CardBody>
  <h2>Entra Reports</h2>
  <p>Inspect directory objects, licenses, audit activity, identity risks, governance requests and provisioning status.
    Reports are read-only and load up to 200 records at a time.</p>
  {error?<p role="alert">{error}</p>:null}
  <form onSubmit={async event=>{
   event.preventDefault();if(busy||!credentialId)return
   setBusy(true);setMessage(null);setData(null)
   try{
    const result=await runOperation('microsoft-entra-id','report-'+reportId,{credentialId,params:Object.fromEntries(Object.entries(params).filter(([,value])=>value!=='').map(([key,value])=>[key,key==='from'||key==='to'?new Date(value).toISOString():value]))})
    if(!result.ok)setMessage(result.message)
    else if(Array.isArray(result.data?.items)&&Array.isArray(result.data?.columns))setData(result.data as unknown as ReportData)
    else setMessage('The report response was incomplete')
   }catch(error){setMessage(error instanceof Error?error.message:'Report failed')}
   finally{setBusy(false)}
  }}>
   <Select label="Connection" id="report-connection" aria-label="Report connection" value={credentialId} onChange={setCredentialId} options={connections.map(c=>({value:c.id,label:c.name}))}/>
   <Select label="Report" id="report-kind" aria-label="Report" value={reportId} onChange={value=>{setReportId(value);setParams({});setData(null);setMessage(null)}} options={ENTRA_REPORTS.map(report=>({value:report.id,label:report.name}))}/>
   <p>Required Graph permission: <code>{definition.permission}</code>.</p>
   {(definition.parameters??[]).map(field=><Input key={field.key} id={`report-${field.key}`} label={field.label} required value={params[field.key]??''} onChange={event=>setParams(previous=>({...previous,[field.key]:event.target.value}))}/>)}
   {definition.timeField?<>
    <Input type="datetime-local" label="From (local time; default last 24 hours)" value={params.from??''} onChange={event=>setParams(previous=>({...previous,from:event.target.value}))}/>
    <Input type="datetime-local" label="To (local time; default now)" value={params.to??''} onChange={event=>setParams(previous=>({...previous,to:event.target.value}))}/>
   </>:null}
   <Button type="submit" disabled={busy||!credentialId}>{busy?'Loading…':'Load report'}</Button>
  </form>
  {message?<p role="alert">{message}</p>:null}
  {data?<div aria-live="polite">
   <p>{data.items.length} record(s){data.truncated?' — more records exist; narrow the filters or use a scoped report.':''}</p>
   <div style={{overflowX:'auto'}}><table><caption>{definition.name}</caption>
    <thead><tr>{data.columns.map(column=><th key={column} scope="col">{column}</th>)}</tr></thead>
    <tbody>{data.items.map((row,index)=><tr key={String(row.id??index)}>{data.columns.map(column=><td key={column}>{display(row[column])}</td>)}</tr>)}</tbody>
   </table></div>
  </div>:null}
 </CardBody></Card>
}
