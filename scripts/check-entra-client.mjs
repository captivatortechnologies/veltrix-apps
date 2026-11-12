import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'

const app = fileURLToPath(new URL('../apps/microsoft-entra-id/', import.meta.url))
const local = createRequire(new URL('../apps/microsoft-entra-id/package.json', import.meta.url))
const sdk = createRequire(new URL('../sdk/package.json', import.meta.url))
const resolve = name => { try { return local.resolve(name) } catch { return sdk.resolve(name) } }
const { JSDOM } = local(resolve('jsdom'))
const result = await build({
  stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
    import Setup from './client/pages/SetupGuidePage'; import Overview from './client/pages/OverviewPage';
    const root=createRoot(document.getElementById('root')); root.render(React.createElement(Setup));
    window.showOverview=()=>root.render(React.createElement(Overview));`, resolveDir: app, loader:'tsx' },
  bundle:true, write:false, platform:'browser', format:'iife',
  alias: {'react':dirname(resolve('react/package.json')),'react-dom':dirname(resolve('react-dom/package.json')),
    '@veltrixsecops/app-sdk/ui':join(app,'../../sdk/src/ui/index.tsx')},
  nodePaths:[join(dirname(resolve('react/package.json')),'..')],
})
const dom=new JSDOM('<!doctype html><div id="root"></div>',{runScripts:'outside-only',url:'https://veltrix.example'})
try {
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
    if(i===1)assert.equal(dom.window.document.querySelectorAll('tbody tr').length,42)
  }
  dom.window.showOverview();await wait()
  assert.ok(dom.window.document.body.textContent.includes('Unavailable with app-only authentication'))
  assert.ok(dom.window.document.body.textContent.includes('Prior write-only client secrets'))
  console.log('Client browser bundle, all six setup tabs, 42 capability rows and overview checks passed')
} finally { dom.window.close() }
