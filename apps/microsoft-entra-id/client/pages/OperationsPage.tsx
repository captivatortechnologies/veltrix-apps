import React,{useState} from 'react'
import { runOperation } from '@veltrixsecops/app-sdk/client'
import { Button,Card,CardBody,Input,Select,Textarea } from '@veltrixsecops/app-sdk/ui'
import { ENTRA_OPERATIONS } from '../../lib/operationDefinitions'
import { useEntraConnections } from '../hooks/useEntraConnections'

export default function OperationsPage(){
 const {connections,error}=useEntraConnections()
 const [operationId,setOperationId]=useState(ENTRA_OPERATIONS[0].id)
 const [credentialId,setCredentialId]=useState('')
 const [params,setParams]=useState<Record<string,unknown>>({})
 const [confirmation,setConfirmation]=useState('')
 const [busy,setBusy]=useState(false)
 const [result,setResult]=useState<{ok:boolean;message:string;data?:Record<string,unknown>}|null>(null)
 const definition=ENTRA_OPERATIONS.find(op=>op.id===operationId)!
 const update=(key:string,value:unknown)=>setParams(previous=>({...previous,[key]:value}))
 return <Card><CardBody>
  <h2>Entra Operations</h2>
  <p>Run a specific administrative action using a saved connection. Changes take effect in the selected tenant;
    some requests require approval or complete asynchronously. Use Reports to verify their outcome.</p>
  {error?<p role="alert">{error}</p>:null}
  {!connections.length?<p>Save a connection on Connections before running an operation.</p>:null}
  <form onSubmit={async event=>{
   event.preventDefault();if(busy||!credentialId||confirmation!==operationId)return
   setBusy(true);setResult(null)
   try{setResult(await runOperation('microsoft-entra-id',operationId,{credentialId,params:{...params,confirmation}}))}
   catch(error){setResult({ok:false,message:error instanceof Error?error.message:'Operation failed'})}
   finally{setBusy(false);setConfirmation('')}
  }}>
   <Select label="Connection" id="operation-connection" aria-label="Operation connection" value={credentialId} onChange={setCredentialId} options={connections.map(c=>({value:c.id,label:c.name}))}/>
   <Select label="Operation" id="operation-kind" aria-label="Operation" value={operationId} onChange={value=>{setOperationId(value);setParams({});setConfirmation('');setResult(null)}} options={ENTRA_OPERATIONS.map(op=>({value:op.id,label:op.name}))}/>
   <p>{definition.description}</p>
   <p>Required Graph permission: <code>{definition.permission}</code>. Your app role must also permit this operation.</p>
   {definition.fields.map(field=>{
    const common={key:field.key,id:`operation-${field.key}`,label:field.label}
    if(field.kind==='enum')return <Select {...common} value={String(params[field.key]??'')} onChange={value=>update(field.key,value)} options={(field.choices??[]).map(value=>({value,label:value}))}/>
    if(field.kind==='json'||field.kind==='ids')return <Textarea {...common} required={field.required} rows={4} value={String(params[field.key]??'')} onChange={event=>update(field.key,event.target.value)} />
    if(field.kind==='boolean')return <Input {...common} type="checkbox" checked={params[field.key]===true} onChange={event=>update(field.key,event.target.checked)}/>
    return <Input {...common} required={field.required} value={String(params[field.key]??'')} onChange={event=>update(field.key,event.target.value)}/>
   })}
   <Input label={`Confirm this action by entering ${operationId}`} id="operation-confirmation" required value={confirmation} onChange={event=>setConfirmation(event.target.value)} autoComplete="off"/>
   <Button type="submit" disabled={busy||!credentialId||confirmation!==operationId}>{busy?'Submitting…':'Run operation'}</Button>
  </form>
  {result?<div role={result.ok?'status':'alert'}><p>{result.message}</p>{result.data&&Object.keys(result.data).length?<dl>{Object.entries(result.data).map(([key,value])=><React.Fragment key={key}><dt>{key}</dt><dd>{String(value)}</dd></React.Fragment>)}</dl>:null}</div>:null}
 </CardBody></Card>
}
