import { useEffect,useState } from 'react'
import { listCredentials,resolveTool } from '@veltrixsecops/app-sdk/client'
export function useEntraConnections(){
 const [connections,setConnections]=useState<Array<{id:string;name:string}>>([])
 const [error,setError]=useState<string|null>(null)
 useEffect(()=>{
  let active=true
  resolveTool('Microsoft Entra ID').then(tool=>tool?listCredentials(tool.id):[])
   .then(rows=>{if(active)setConnections(rows.map(row=>({id:row.id,name:row.name})))})
   .catch(error=>{if(active)setError(error instanceof Error?error.message:'Unable to load connections')})
  return ()=>{active=false}
 },[])
 return {connections,error}
}
