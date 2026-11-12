import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { GraphClient, readGraphSettings, resolveGraphCredential, GRAPH_CLOUDS } from '../graph'
import { CAPABILITIES } from '../capabilities'
import { reconciliationIssue } from '../reconciliation'
import { probeSelectedFeatures } from '../readiness'
import { verifyManagedConfiguration } from '../verification'
import { CheckedNameMap, buildNameMap, lookupName } from '../../config-types/lib/checkedNames'
import { resolveRef, resolveAcrossMaps } from '../../config-types/lib/nameMaps'
import validateAgreement from '../../config-types/terms-of-use-agreements/validate'
import validatePolicy from '../../config-types/conditional-access-policies/validate'
import deployPolicy from '../../config-types/conditional-access-policies/deploy'
import { TOKEN, recordFetch, collection, graphError, healthContext, deployContext, item, writeCalls } from './fakeGraph'

const CREDENTIAL = healthContext().credential!
const cred = { tenantId: 'tenant-a', clientId: 'client-a', clientSecret: 'test-secret' }
const client = () => new GraphClient({ cred, timeoutMs: 1000 })

test('lost mutation response is uncertain and never blindly retried', async () => {
 const original = globalThis.fetch
 let committed = 0
 globalThis.fetch = async (url) => {
  if (String(url).includes('/token')) return new Response(JSON.stringify({ access_token: 'test-token' }))
  committed++
  throw new Error('socket lost after commit')
 }
 try {
  const result = await client().post('/groups', { displayName: 'Ops' })
  assert.equal(committed, 1); assert.equal(result.uncertain, true)
  assert.match(result.body, /reconcile stable IDs/)
 } finally { globalThis.fetch = original }
})

test('read transport failure retries once', async () => {
 const original = globalThis.fetch
 let reads = 0
 globalThis.fetch = async url => {
  if (String(url).includes('/token')) return new Response(JSON.stringify({ access_token: 'test-token' }))
  if (++reads === 1) throw new Error('network unavailable')
  return new Response('{"value":[]}')
 }
 try { assert.equal((await client().get('/groups')).ok, true); assert.equal(reads, 2) }
 finally { globalThis.fetch = original }
})

test('foreign-origin and non-Graph URLs are rejected before token acquisition', async () => {
 const { calls, restore } = recordFetch([])
 try {
  for (const url of ['https://attacker.example/v1.0/groups','http://graph.microsoft.com/v1.0/groups','https://graph.microsoft.com.evil/v1.0/groups','https://user@graph.microsoft.com/v1.0/groups','https://graph.microsoft.com/beta/groups']) {
   assert.equal((await client().get(url)).ok, false)
  }
  assert.equal(calls.length, 0)
 } finally { restore() }
})

test('foreign pagination never receives the bearer token', async () => {
 const { calls, restore } = recordFetch([TOKEN, {status:200, body:{value:[], '@odata.nextLink':'https://attacker.example/v1.0/groups'}}])
 try { const result = await client().getAll('/groups'); assert.equal(result.ok,false); assert.equal(calls.length,2) }
 finally { restore() }
})

test('malformed successful collections are failed reads, never empty truth', async () => {
 const { restore } = recordFetch([TOKEN, {status:200,body:{unexpected:[]}}])
 try { assert.equal((await client().getAll('/groups')).ok,false) } finally { restore() }
})

test('429 retries once and preserves the final failure', async () => {
 const original = globalThis.fetch; let reads=0
 globalThis.fetch = async url => String(url).includes('/token') ? new Response('{"access_token":"t"}')
  : (++reads, new Response('{}',{status:429,headers:{'Retry-After':'0.001'}}))
 try { assert.equal((await client().get('/groups')).status,429); assert.equal(reads,2) }
 finally { globalThis.fetch=original }
})

test('credential overrides isolate tenants and clouds without changing legacy fallback', () => {
 const settings = readGraphSettings({tenant_id:'legacy', connection_tenants:JSON.stringify({[CREDENTIAL.id]:{tenantId:'override',cloud:'us-gov'}})})
 const resolved=resolveGraphCredential(CREDENTIAL,settings)!
 assert.equal(resolved.tenantId,'override'); assert.equal(resolved.cloud,'us-gov')
 assert.equal(resolveGraphCredential({...CREDENTIAL,id:'other'},settings)!.tenantId,'legacy')
 assert.equal(resolveGraphCredential({...CREDENTIAL,password:'',apiToken:'saved-ui-secret'},settings)!.clientSecret,'saved-ui-secret')
})

for (const [cloud, hosts] of Object.entries(GRAPH_CLOUDS)) test(`${cloud} uses its own authority, scope and Graph origin`,async () => {
 const {calls,restore}=recordFetch([TOKEN,collection([])])
 try {
  const result=await new GraphClient({cred:{...cred,cloud},timeoutMs:1000}).get('/groups')
  assert.equal(result.ok,true); assert.ok(calls[0].url.startsWith(hosts.login+'/tenant-a/'))
  assert.equal(new URLSearchParams(String(calls[0].body)).get('scope'),hosts.graph+'/.default')
  assert.ok(calls[1].url.startsWith(hosts.graph+'/v1.0/'))
 } finally {restore()}
})

test('broker token source is tenant-scoped and makes no secret token exchange',async () => {
 const inputs: unknown[]=[]; const {calls,restore}=recordFetch([collection([])])
 try {
  const result=await new GraphClient({cred:{...cred,clientSecret:'',cloud:'us-gov',identity:{getAccessToken:async input=>{inputs.push(input);return 'broker-token'}}},timeoutMs:1000}).get('/groups')
  assert.equal(result.ok,true); assert.equal(calls.length,1)
  assert.deepEqual(inputs,[{tenantId:'tenant-a',resource:'https://graph.microsoft.us',cloud:'us-gov'}])
 } finally {restore()}
})

test('invalid certificate fails without sending a secret or Graph request',async () => {
 const {calls,restore}=recordFetch([])
 try {
  const result=await new GraphClient({cred:{...cred,certificate:'not a PEM certificate'},timeoutMs:1000}).get('/groups')
  assert.equal(result.stage,'authentication'); assert.equal(calls.length,0)
 } finally {restore()}
})

test('capability registry covers the manifest exactly, including unsupported agreement management',()=>{
 const manifest=readFileSync('apps/microsoft-entra-id/manifest.yaml','utf8')
 const ids=[...manifest.matchAll(/^    - id: ([\w-]+)$/gm)].map(m=>m[1]).sort()
 assert.deepEqual(CAPABILITIES.map(c=>c.id).sort(),ids)
 assert.equal(new Set(CAPABILITIES.map(c=>c.id)).size,42)
 const unsupported=CAPABILITIES.filter(c=>!c.appOnly)
 assert.deepEqual(unsupported.map(c=>c.id),['terms-of-use-agreements'])
 for(const cap of CAPABILITIES.filter(c=>c.appOnly)) { assert.ok(cap.readPermissions.length);assert.ok(cap.writePermissions.length);assert.equal(cap.apiVersion,'v1.0') }
})

test('selected-feature readiness distinguishes permitted reads, missing consent and unsupported APIs',async()=>{
 const {calls,restore}=recordFetch([TOKEN,collection([]),graphError(403,'Insufficient privileges')])
 try {
  const results=await probeSelectedFeatures(client(),['groups','applications','terms-of-use-agreements','unknown'])
  assert.deepEqual(results.map(c=>c.ok),[true,false,false,false])
  assert.match(results[0].detail,/writes and licensing unverified/);assert.match(results[1].detail,/Application.Read.All/)
  assert.equal(writeCalls(calls).length,0); assert.equal(calls.length,3)
 } finally {restore()}
})

test('duplicate names and incomplete lookups cannot resolve names, but explicit IDs pass',async()=>{
 const map=new CheckedNameMap();map.set('ops','a');map.set('ops','b')
 assert.equal(lookupName(map,'Ops').status,'ambiguous');assert.equal(map.get('ops'),undefined)
 const id='11111111-1111-1111-1111-111111111111';assert.equal(resolveRef(id,map).id,id)
 assert.equal(resolveAcrossMaps('Ops',[new Map([['ops','a']]),new Map([['ops','b']])]).missing,true)
 const stub={getAll:async()=>({ok:true,truncated:true,items:[{id:'a',displayName:'Ops'}]})}
 const capped=await buildNameMap(stub as never,'/groups'); assert.equal(lookupName(capped,'Ops').status,'incomplete')
 const failed=await buildNameMap({getAll:async()=>({ok:false,truncated:false,items:[]})} as never,'/groups')
 assert.equal(lookupName(failed,'Ops').status,'failed')
})

test('reconciliation blocks partial listings and duplicate requested names',()=>{
 assert.match(reconciliationIssue({ok:true,truncated:true,items:[]},[])!,/truncated/)
 assert.match(reconciliationIssue({ok:true,truncated:false,items:[{id:'a',displayName:'Ops'},{id:'b',displayName:'ops'}]},['Ops'])!,/Ambiguous/)
 assert.equal(reconciliationIssue({ok:true,truncated:false,items:[{id:'a',displayName:'Ops'},{id:'b',displayName:'ops'}]},['Other']),null)
})

test('health cannot call reachability verified configuration; missing, changed and unchecked resources fail',async()=>{
 const context=healthContext();context.canvas.items=[item('Ops',{name:'Ops'})]
 for(const result of [{checked:false,hasDrift:false,diffs:[]},{hasDrift:true,diffs:[{field:'Ops',actual:'absent',expected:'present',severity:'critical'}]}]) {
  const health=await verifyManagedConfiguration(context,[{name:'connectivity',passed:true,message:'reachable'}],async()=>result as never)
  assert.equal(health.healthy,false);assert.equal(health.score,50)
 }
 assert.equal((await verifyManagedConfiguration(context,[{name:'connectivity',passed:true,message:'reachable'}],async()=>({hasDrift:false,diffs:[]}))).healthy,true)
})

test('agreement validation blocks app-only use even for otherwise valid data',()=>{
 const result=validateAgreement(deployContext([item('Terms',{name:'Terms',fileData:'SGVsbG8='})]))
 assert.equal(result.valid,false);assert.ok(result.errors.some(e=>e.code==='unsupported_authentication'))
})

test('tenant-wide enforcement requires acknowledgement before any network call',async()=>{
 const context=deployContext([item('MFA',{name:'MFA',state:'enabled',includeAllUsers:true,includeAllApps:true,builtInControls:['mfa']})])
 assert.ok(validatePolicy(context).errors.some(e=>e.code==='enforcement_acknowledgement_required'))
 const {calls,restore}=recordFetch([])
 try {assert.equal((await deployPolicy(context)).success,false);assert.equal(calls.length,0)}finally{restore()}
})

test('enabled policy refuses writes when Security Defaults are enabled or unreadable',async()=>{
 for(const response of [{status:200,body:{isEnabled:true}},graphError(403,'denied')]) {
  const {calls,restore}=recordFetch([TOKEN,response])
  try {
   const context=deployContext([item('MFA',{name:'MFA',state:'enabled',includeAllUsers:true,enforcementAcknowledged:true,includeAllApps:true,builtInControls:['mfa']})])
   assert.equal((await deployPolicy(context)).success,false);assert.equal(writeCalls(calls).length,0)
  }finally{restore()}
 }
})
