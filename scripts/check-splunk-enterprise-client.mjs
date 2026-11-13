import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'
import yaml from 'js-yaml'

const app = fileURLToPath(new URL('../apps/splunk-enterprise/', import.meta.url))
const sdk = createRequire(new URL('../sdk/package.json', import.meta.url))
const { JSDOM } = sdk('jsdom')
const manifest = yaml.load(readFileSync(join(app, 'manifest.yaml'), 'utf8'))
const result = await build({
  stdin: {
    contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
      import Setup from './client/pages/SetupGuidePage'; import Overview from './client/pages/OverviewPage';
      import Connections from './client/pages/ConnectionsPage'; import {CONFIGURATION_AREAS} from './client/lib/capabilities';
      window.areas=CONFIGURATION_AREAS; const root=createRoot(document.getElementById('root'));
      root.render(React.createElement(Setup)); window.showOverview=()=>root.render(React.createElement(Overview));
      window.showConnections=()=>root.render(React.createElement(Connections));`,
    resolveDir: app, loader: 'tsx',
  },
  bundle: true, write: false, platform: 'browser', format: 'iife',
  alias: {
    react: dirname(sdk.resolve('react/package.json')), 'react-dom': dirname(sdk.resolve('react-dom/package.json')),
    '@veltrixsecops/app-sdk/connections': join(app, '../../sdk/src/connections/index.tsx'),
    '@veltrixsecops/app-sdk/client': join(app, '../../sdk/src/client/index.ts'),
    '@veltrixsecops/app-sdk/ui': join(app, '../../sdk/src/ui/index.tsx'),
  },
  nodePaths: [join(dirname(sdk.resolve('react/package.json')), '..')],
})
const dom = new JSDOM('<!doctype html><div id="root"></div>', { runScripts: 'outside-only', url: 'https://veltrix.example' })
try {
  dom.window.__VELTRIX_APP_RUNTIME__ = {
    sdk: {
      resolveTool: async () => ({ id: 'tool' }), listCredentials: async () => [],
      listEnvironments: async () => [{ id: 'env', name: 'Sandbox' }], listInventory: async () => [],
    },
    authFetch: async url => ({ ok: true, json: async () => url === '/api/apps/enabled' ? [] : [{ id: 'version', version: '10.4.0', isLatest: true }] }),
  }
  dom.window.eval(result.outputFiles[0].text)
  const wait = () => new Promise(resolve => setTimeout(resolve, 40))
  await wait()
  const tabs = [...dom.window.document.querySelectorAll('[role="tab"]')]
  assert.equal(tabs.length, 6)
  const expected = ['sandbox', 'HEC ingestion token cannot authenticate', '8089', 'package backups', 'etc/shcluster/apps', '401 authentication failed']
  for (let i = 0; i < tabs.length; i++) {
    tabs[i].click(); await wait()
    assert.equal(tabs[i].getAttribute('aria-selected'), 'true')
    assert.ok(dom.window.document.querySelector('[role="tabpanel"]').textContent.includes(expected[i]), `Setup step ${i + 1} is incomplete`)
  }
  assert.equal(dom.window.areas.length, manifest.pipeline.configurationTypes.length)
  for (const type of manifest.pipeline.configurationTypes) {
    const area = dom.window.areas.find(area => area.id === type.id)
    assert.ok(area, `Overview/setup missing ${type.id}`)
    assert.deepEqual([...area.componentTypes].sort(), [...type.targets.componentTypes].sort(), `${type.id} target documentation differs from manifest`)
  }
  dom.window.showOverview(); await wait(); await wait()
  for (const area of dom.window.areas) assert.ok(dom.window.document.body.textContent.includes(area.name))
  assert.ok(dom.window.document.body.textContent.includes('License Records'))
  dom.window.showConnections(); await wait(); await wait()
  const add = [...dom.window.document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Add connection')
  assert.ok(add); add.click(); await wait()
  const dialog = dom.window.document.querySelector('[role="dialog"]')
  assert.ok(dialog)
  assert.ok(dialog.textContent.includes('Splunk authentication token (not HEC)'))
  assert.ok(dialog.textContent.includes('HEC (8088)'))
  console.log('Splunk client checks passed: six setup steps, manifest target parity, complete overview and connection guidance')
} finally { dom.window.close() }
