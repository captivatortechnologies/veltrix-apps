import test from 'node:test'
import assert from 'node:assert/strict'
import register from '../index'

async function routes() {
 const routes = new Map<string,any>()
 const permitted:string[]=[]
 const ctx={appId:'microsoft-entra-id',manifest:{name:'Entra',version:'0.9.0',permissions:{app:[{resource:'groups'},{resource:'conditional-access-policies'}]},pipeline:{configurationTypes:[]}},
  hasPermission:(resource:string,action:string)=>async (_req:unknown,reply:any)=>{
   permitted.push(resource+':'+action)
   if(resource!=='groups')return reply.status(403).send({error:'denied'})
  },db:{appInstallation:{findFirst:async()=>({settings:{tenant_id:'tenant',azure_cloud:'global',unexpected_secret:'hidden'}})}}}
 await register({get:(path:string,options:unknown)=>routes.set(path,options)} as never,ctx as never)
 return {routes,permitted}
}
function reply(){return {statusCode:200,payload:undefined as any,status(n:number){this.statusCode=n;return this},send(data:unknown){this.payload=data;return this}}}

test('group-only operator can authorize metadata through the existing groups permission',async()=>{
 const {routes:map,permitted}=await routes();const route=map.get('/meta');const response=reply()
 const request={query:{resource:'groups'},user:{customerId:'customer'}}
 await route.preHandler[0](request,response);assert.deepEqual(permitted,['groups:read'])
 await route.handler(request,response);assert.equal(response.statusCode,200);assert.equal(response.payload.appId,'microsoft-entra-id')
})
test('unrelated permission and unknown resource cannot bypass RBAC',async()=>{
 const {routes:map}=await routes();const route=map.get('/meta')
 for(const [resource,status] of [['conditional-access-policies',403],['not-a-resource',400]] as const){
  const response=reply();await route.preHandler[0]({query:{resource}},response);assert.equal(response.statusCode,status)
 }
})
test('settings response is tenant-authenticated and only returns documented non-secret fields',async()=>{
 const {routes:map}=await routes();const route=map.get('/settings');const response=reply()
 await route.handler({user:{customerId:'customer'}},response)
 assert.deepEqual(response.payload.settings,{tenant_id:'tenant',azure_cloud:'global'})
 const unauth=reply();await route.handler({},unauth);assert.equal(unauth.statusCode,401)
})
