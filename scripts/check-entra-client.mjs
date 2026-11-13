import { build } from 'esbuild'
import {readFileSync} from 'node:fs'
import yaml from 'js-yaml'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'

const app = fileURLToPath(new URL('../apps/microsoft-entra-id/', import.meta.url))
const local = createRequire(new URL('../apps/microsoft-entra-id/package.json', import.meta.url))
const sdk = createRequire(new URL('../sdk/package.json', import.meta.url))
const resolve = name => { try { return local.resolve(name) } catch { return sdk.resolve(name) } }
const onboarding=yaml.load(readFileSync(join(app,'manifest.yaml'),'utf8')).connection.onboarding
const { JSDOM } = local(resolve('jsdom'))
const result = await build({
  stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
    import Setup from './client/pages/SetupGuidePage'; import {CAPABILITIES} from './lib/capabilities'; window.capabilityCount=CAPABILITIES.length; import Overview from './client/pages/OverviewPage'; import Operations from './client/pages/OperationsPage'; import Reports from './client/pages/ReportsPage'; import Connections from './client/pages/ConnectionsPage'; import {ENTRA_OPERATIONS} from './lib/operationDefinitions'; import {ENTRA_REPORTS} from './lib/reportDefinitions'; window.operationCount=ENTRA_OPERATIONS.length; window.reportCount=ENTRA_REPORTS.length;
    const root=createRoot(document.getElementById('root')); root.render(React.createElement(Setup));
    window.showOverview=()=>root.render(React.createElement(Overview)); window.showOperations=()=>root.render(React.createElement(Operations)); window.showReports=()=>root.render(React.createElement(Reports)); window.showConnections=()=>root.render(React.createElement(Connections));`, resolveDir: app, loader:'tsx' },
  bundle:true, write:false, platform:'browser', format:'iife',
  alias: {'react':dirname(resolve('react/package.json')),'react-dom':dirname(resolve('react-dom/package.json')),
    '@veltrixsecops/app-sdk/connections':join(app,'../../sdk/src/connections/index.tsx'),
    '@veltrixsecops/app-sdk/client':join(app,'../../sdk/src/client/index.ts'),
    '@veltrixsecops/app-sdk/ui':join(app,'../../sdk/src/ui/index.tsx')},
  nodePaths:[join(dirname(resolve('react/package.json')),'..')],
})
const dom=new JSDOM('<!doctype html><div id="root"></div>',{runScripts:'outside-only',url:'https://veltrix.example'})
try {
  const requests=[]
  dom.window.__VELTRIX_APP_RUNTIME__={sdk:{resolveTool:async()=>({id:'tool'}),listCredentials:async()=>[{id:'connection',name:'Sandbox tenant',type:'OAUTH',username:'connector',hasSecret:false}],listEnvironments:async()=>[{id:'env-1',name:'Production'}],listInventory:async()=>[]},authFetch:async(url,init)=>{
    requests.push({url,body:init?.body?JSON.parse(init.body):undefined})
    if(url==='/api/apps/enabled')return {ok:true,json:async()=>[{appId:'microsoft-entra-id',connection:{onboarding:{provider:onboarding.provider,label:onboarding.label,description:onboarding.description,componentType:onboarding.componentType,brokered:true,requiredSettings:[]}}}]}
    if(url.endsWith('/connections/onboard/start'))return {ok:true,json:async()=>({authorizeUrl:'https://veltrix.example/#consent-test',provider:onboarding.provider})}
    return {ok:true,json:async()=>url.includes('/report-')?{ok:true,message:'Read',data:{columns:['id','displayName'],items:[{id:'user-id',displayName:'Sandbox user'}],truncated:true}}:{ok:true,message:'Action accepted',data:{id:'created-id'}}}
  }}
  dom.window.eval(result.outputFiles[0].text)
  const wait=()=>new Promise(resolve=>setTimeout(resolve,30))
  await wait()
  const tabs=[...dom.window.document.querySelectorAll('[role="tab"]')]
  assert.equal(tabs.length,6)
  const expected=['test tenant','Application permissions','Secret ID','Test scope','emergency-access','Graph 401']
  for(let i=0;i<tabs.length;i++) {
    tabs[i].click();await wait()
    assert.equal(tabs[i].getAttribute('aria-selected'),'true')
    assert.ok(dom.window.document.querySelector('[role="tabpanel"]').textContent.includes(expected[i]),`Step ${i+1} content missing`)
    if(i===1)assert.equal(dom.window.document.querySelectorAll('tbody tr').length,dom.window.capabilityCount)
  }
  dom.window.showOverview();await wait()
  assert.ok(dom.window.document.body.textContent.includes('Unavailable with app-only authentication'))
  assert.ok(dom.window.document.body.textContent.includes('Prior write-only client secrets'))
  const change=(selector,value)=>{const element=typeof selector==='string'?dom.window.document.querySelector(selector):selector;assert.ok(element,selector);const proto=element.tagName==='SELECT'?dom.window.HTMLSelectElement.prototype:dom.window.HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(element,value);element.dispatchEvent(new dom.window.Event(element.tagName==='SELECT'?'change':'input',{bubbles:true}));element.dispatchEvent(new dom.window.Event('change',{bubbles:true}))}
  dom.window.showOperations();await wait();await wait()
  assert.equal(dom.window.document.querySelectorAll('#operation-kind option').length,dom.window.operationCount+1)
  assert.equal(dom.window.document.querySelector('button[type="submit"]').disabled,true)
  change('#operation-connection','connection');change('#operation-id','example.test');change('#operation-confirmation','create-domain');await wait()
  assert.equal(dom.window.document.querySelector('button[type="submit"]').disabled,false)
  dom.window.document.querySelector('form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));await wait()
  assert.equal(requests.length,1);assert.ok(requests[0].url.endsWith('/create-domain'));assert.equal(requests[0].body.credentialId,'connection');assert.equal(requests[0].body.params.id,'example.test')
  assert.ok(dom.window.document.body.textContent.includes('Action accepted'));assert.equal(dom.window.document.querySelector('#operation-confirmation').value,'')
  dom.window.showReports();await wait();await wait()
  assert.equal(dom.window.document.querySelectorAll('#report-kind option').length,dom.window.reportCount+1)
  change('#report-connection','connection');await wait()
  dom.window.document.querySelector('form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));await wait()
  assert.equal(requests.length,2);assert.ok(requests[1].url.endsWith('/report-users'));assert.ok(dom.window.document.body.textContent.includes('Sandbox user'));assert.ok(dom.window.document.body.textContent.includes('more records exist'))
  dom.window.showConnections();await wait();await wait()
  const connect=[...dom.window.document.querySelectorAll('button')].find(button=>button.textContent.includes(onboarding.label))
  assert.ok(connect,'Microsoft OAuth button missing');assert.equal(connect.disabled,false);connect.click();await wait()
  const dialog=dom.window.document.querySelector('[role="dialog"]');assert.ok(dialog,'OAuth connect dialog missing')
  assert.equal(dialog.textContent.includes('Client secret'),false)
  change(dialog.querySelector('input'),'Production Entra');change(dialog.querySelector('select'),'env-1');await wait()
  dialog.querySelector('form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));await wait()
  const request=requests.find(request=>request.url.endsWith('/connections/onboard/start'))
  assert.ok(request,'OAuth onboarding start was not submitted')
  assert.deepEqual(request.body,{provider:'entra-oidc-consent',connectionName:'Production Entra',environmentId:'env-1',settings:{}})
  assert.equal(dom.window.location.hash,'#consent-test')
  console.log('Client browser checks passed: setup, registry, operations, reports and OAuth connection dialog/redirect submission')
} finally { dom.window.close() }
