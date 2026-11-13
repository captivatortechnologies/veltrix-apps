import test from 'node:test'
import assert from 'node:assert/strict'
import { __setSplunkTransport, buildSplunkUrl, getEntityContent, normalizeSplunkUrl } from '../splunkApi'
import testConnection from '../../handlers/testConnection'
import deployApps from '../../config-types/apps/deploy'
import appHealth from '../../config-types/apps/healthCheck'
import appDrift from '../../config-types/apps/driftDetect'
import appRollback from '../../config-types/apps/rollback'
import hecDeploy from '../../config-types/hec-tokens/deploy'
import hecHealth from '../../config-types/hec-tokens/healthCheck'
import hecDrift from '../../config-types/hec-tokens/driftDetect'
import hecRollback from '../../config-types/hec-tokens/rollback'
import poolDeploy from '../../config-types/license-pools/deploy'
import poolHealth from '../../config-types/license-pools/healthCheck'
import poolDrift from '../../config-types/license-pools/driftDetect'
import poolRollback from '../../config-types/license-pools/rollback'
import tokenDeploy from '../../config-types/auth-tokens/deploy'
import tokenHealth from '../../config-types/auth-tokens/healthCheck'
import tokenDrift from '../../config-types/auth-tokens/driftDetect'
import tokenRollback from '../../config-types/auth-tokens/rollback'
import { getLiveLicenseStatus } from '../liveLicense'

const credential = { id: 'cred', name: 'Service', username: 'svc', password: 'pw', apiToken: null }
const component = { id: 'host', hostname: 'splunk.internal', port: '8089', type: ['search-head'], toolId: 'tool' }
const fields = { name: 'managed', username: 'svc', audience: 'veltrix', tokenType: 'static', enabled: true, stackId: 'Enterprise', quota: '100B' }
function context(extra: Record<string, unknown> = {}): any {
  const canvas = { name: 'implicit_app', version: 1, sections: [{ fields }] }
  return { component, credential, connectivity: null, connectivityProvider: null, canvas, deployedConfig: canvas, settings: {}, ...extra }
}
const response = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => typeof body === 'string' ? body : JSON.stringify(body) })
const entity = (content: Record<string, unknown>) => response({ entry: [{ content }] })

test('management URLs normalize ports, trailing slashes and explicit proxy URLs consistently', () => {
  assert.equal(normalizeSplunkUrl(' splunk.internal '), 'https://splunk.internal:8089')
  assert.equal(normalizeSplunkUrl('splunk.internal:9090/'), 'https://splunk.internal:9090')
  assert.equal(normalizeSplunkUrl('splunk.internal:443'), 'https://splunk.internal')
  assert.equal(buildSplunkUrl({ ...component, port: '' } as any, null, null, { splunk_api_port: 9090 }), 'https://splunk.internal:9090')
  assert.equal(normalizeSplunkUrl('https://proxy.example/splunk/'), 'https://proxy.example/splunk')
  assert.equal(buildSplunkUrl(component as any, { httpsUrl: 'https://proxy.example/' } as any), 'https://proxy.example')
  for (const invalid of ['ftp://host', 'https://user:secret@host', 'https://host?token=secret', 'https://host#secret']) assert.throws(() => normalizeSplunkUrl(invalid))
})

test('connection testing uses the shared transport and management port for a bare host', async () => {
  let seen = ''
  __setSplunkTransport(async (url, init) => { seen = url; assert.equal(init.headers?.Authorization, 'Basic c3ZjOnB3'); assert.equal(init.timeoutMs, 10000); return entity({ version: '10.4.0' }) })
  try {
    const result = await testConnection(context({ endpoint: 'splunk.internal' }))
    assert.equal(result.ok, true); assert.equal(seen, 'https://splunk.internal:8089/services/server/info?output_mode=json')
    assert.match(result.details!.join(' '), /read access only/)
  } finally { __setSplunkTransport(null) }
})

test('connection testing honors managed connectivity, custom ports and authentication tokens', async () => {
  const seen: string[] = []
  __setSplunkTransport(async (url, init) => { seen.push(url); assert.equal(init.headers?.Authorization, 'Bearer authentication-token'); return entity({ version: '10.4.0' }) })
  try {
    const auth = { ...credential, apiToken: ' authentication-token ' }
    assert.equal((await testConnection(context({ endpoint: null, credential: auth, component: { ...component, port: '9090' } }))).ok, true)
    assert.equal((await testConnection(context({ endpoint: 'unreachable.local', credential: auth, connectivityProvider: { config: { deviceAddress: '100.64.1.2' } } }))).ok, true)
    assert.ok(seen[0].startsWith('https://splunk.internal:9090/')); assert.ok(seen[1].startsWith('https://100.64.1.2:8089/'))
  } finally { __setSplunkTransport(null) }
})

for (const [status, body, message] of [[401, {}, /HEC/], [403, {}, /capabilities/], [302, 'login', /redirected/], [200, '<html>Login</html>', /did not return Splunk/], [200, {}, /did not return Splunk/]] as const) {
  test(`connection test rejects a wrong endpoint or unusable authentication (${status}, ${JSON.stringify(body)})`, async () => {
    __setSplunkTransport(async () => response(body, status))
    try { const result = await testConnection(context({ endpoint: 'splunk.internal' })); assert.equal(result.ok, false); assert.match(result.message, message) } finally { __setSplunkTransport(null) }
  })
}

test('invalid endpoints and incomplete credentials fail without sending a network request', async () => {
  let calls = 0; __setSplunkTransport(async () => { calls++; return entity({ version: '10.4.0' }) })
  try {
    for (const extra of [{ endpoint: 'https://user:secret@host' }, { endpoint: 'host', credential: { id: 'empty' } }]) assert.equal((await testConnection(context(extra))).ok, false)
    assert.equal(calls, 0)
  } finally { __setSplunkTransport(null) }
})

for (const status of [401, 403, 500]) {
  test(`unreadable entity (${status}) is not treated as absent`, async () => {
    __setSplunkTransport(async () => response('unreadable', status))
    try { await assert.rejects(getEntityContent('https://host', {}, '/entity'), new RegExp(String(status))) } finally { __setSplunkTransport(null) }
  })
}
test('only a confirmed missing entity returns null; malformed successful responses fail', async () => {
  __setSplunkTransport(async () => response({}, 404))
  try { assert.equal(await getEntityContent('https://host', {}, '/entity'), null); __setSplunkTransport(async () => response({})); await assert.rejects(getEntityContent('https://host', {}, '/entity'), /valid content/) } finally { __setSplunkTransport(null) }
})

for (const [name, deploy] of [['apps', deployApps], ['HEC', hecDeploy], ['pools', poolDeploy], ['tokens', tokenDeploy]] as const) {
  test(`${name} deployment stops before mutation when its state cannot be read`, async () => {
    const methods: string[] = []
    __setSplunkTransport(async (_url, init) => { methods.push(init.method ?? 'GET'); return response({}, 403) })
    try { assert.equal((await deploy(context())).success, false); assert.ok(methods.length); assert.ok(methods.every(method => method === 'GET')) } finally { __setSplunkTransport(null) }
  })
}

for (const [name, health, drift, rollback, data] of [
  ['HEC', hecHealth, hecDrift, hecRollback, { createdTokens: ['managed'] }],
  ['pools', poolHealth, poolDrift, poolRollback, { createdPools: ['managed'] }],
  ['tokens', tokenHealth, tokenDrift, tokenRollback, { entries: [{ username: 'svc', id: 'token', created: true }] }],
] as const) {
  test(`${name} health, drift and rollback all use address-only connections`, async () => {
    let calls = 0
    __setSplunkTransport(async () => { calls++; return entity({ version: '10.4.0', disabled: false, quota: '100', stack_id: 'Enterprise', status: 'enabled', audience: 'veltrix', type: 'static' }) })
    try {
      await health(context()); assert.ok(calls > 0, 'health must reach Splunk')
      calls = 0; const result = await drift(context()); assert.notEqual(result.checked, false); assert.ok(calls > 0, 'drift must reach Splunk')
      calls = 0; assert.equal((await rollback(context({ rollbackData: data }))).success, true); assert.ok(calls > 0, 'rollback must reach Splunk')
    } finally { __setSplunkTransport(null) }
  })
}

for (const [name, drift] of [['apps', appDrift], ['HEC', hecDrift], ['pools', poolDrift]] as const) {
  test(`${name} drift reports denied reads instead of clearing drift`, async () => {
    __setSplunkTransport(async () => response({}, 403))
    try { const result = await drift(context()); assert.equal(result.hasDrift, true); assert.ok(result.diffs.some(diff => diff.actual === 'HTTP 403')) } finally { __setSplunkTransport(null) }
  })
}

test('app checks resolve implicit app IDs and respect the target roles of each item', async () => {
  const seen: string[] = []
  __setSplunkTransport(async url => { seen.push(url); return entity({ version: '10.4.0', disabled: 1 }) })
  const canvas = { name: 'implicit_app', sections: [{ fields: { source: 'inline', state: 'disabled', targetTypes: ['search-head'] } }, { fields: { name: 'wrong_role', targetTypes: ['indexer'] } }] }
  try {
    assert.equal((await appHealth(context({ canvas }))).healthy, true)
    const result = await appDrift(context({ deployedConfig: canvas })); assert.equal(result.hasDrift, false)
    assert.ok(seen.some(url => url.includes('/apps/local/implicit_app?'))); assert.ok(seen.every(url => !url.includes('wrong_role')))
  } finally { __setSplunkTransport(null) }
})

test('pool stack changes retain enough state to restore the original pool, even after creation fails', async () => {
  for (const createFails of [false, true]) {
    let live: Record<string, unknown> | null = { stack_id: 'Free', quota: '100', peers: 'peer-a', description: 'original' }
    let restoring = false
    __setSplunkTransport(async (_url, init) => {
      if ((init.method ?? 'GET') === 'GET') return live ? entity(live) : response({}, 404)
      if (init.method === 'DELETE') { live = null; return response({}) }
      const payload = Object.fromEntries(new URLSearchParams(String(init.body)))
      if (createFails && !restoring && payload.stack_id === 'Enterprise') return response({}, 500)
      live = { ...live, ...payload }; return response({})
    })
    try {
      const deployed = await poolDeploy(context()); assert.equal(deployed.success, !createFails)
      const data = deployed.rollbackData as any
      assert.deepEqual(data.recreatedPools, ['managed']); assert.equal(data.previousState[0].stack_id, 'Free'); assert.deepEqual(data.createdPools, [])
      restoring = true
      assert.equal((await poolRollback(context({ rollbackData: data }))).success, true)
      assert.equal(live!.stack_id, 'Free'); assert.equal(live!.quota, '100'); assert.equal(live!.description, 'original')
      assert.equal((await poolRollback(context({ rollbackData: data }))).success, true, 'restoration can be retried')
    } finally { __setSplunkTransport(null) }
  }
})

for (const [name, rollback, data] of [['pools', poolRollback, { createdPools: ['managed'] }], ['tokens', tokenRollback, { entries: [{ id: 'token', username: 'svc', created: true }] }]] as const) {
  test(`${name} rollback reports incomplete cleanup as failure`, async () => {
    __setSplunkTransport(async () => response({}, 403))
    try { const result = await rollback(context({ rollbackData: data })); assert.equal(result.success, false); assert.match(result.message, /incomplete/) } finally { __setSplunkTransport(null) }
  })
}

test('failed remote app cleanup or bundle pushes cannot report a successful rollback', async () => {
  for (const failedAction of ['removePath', 'applyClusterBundle']) {
    __setSplunkTransport(async () => response({}))
    try {
      const result = await appRollback(context({ rollbackData: { previousState: [{ name: 'managed', existed: false }], stagingPlaced: [{ appId: 'managed', role: 'cluster-manager', dir: 'etc/manager-apps', existed: false }] }, remote: { homeDir: '/opt/splunk', run: async (intent: any) => ({ ok: intent.action !== failedAction, code: 1 }) } }))
      assert.equal(result.success, false)
    } finally { __setSplunkTransport(null) }
  }
})

test('live license reads degrade safely on connection resolver and input failures', async () => {
  assert.equal((await getLiveLicenseStatus(async () => { throw new Error('vault unavailable') }, 'customer', 'credential')).available, false)
  assert.equal((await getLiveLicenseStatus(async () => ({ ...credential, endpoint: 'https://user:secret@host', certificate: null }), 'customer', 'credential')).available, false)
})




test('rollback preserves existing staging content and reports missing prior package bytes', async () => {
  const actions: string[] = []
  __setSplunkTransport(async () => response({}))
  try {
    const result = await appRollback(context({ rollbackData: { previousState: [{ name: 'managed', existed: true, version: '1.0' }], installedApps: ['managed'], stagingPlaced: [{ appId: 'managed', role: 'cluster-manager', dir: 'etc/manager-apps' }] }, remote: { homeDir: '/opt/splunk', run: async (intent: any) => { actions.push(intent.action); return { ok: true, code: 0 } } } }))
    assert.equal(result.success, false); assert.match(result.message, /restore.*backup/); assert.deepEqual(actions, [])
  } finally { __setSplunkTransport(null) }
})


test('HEC health checks honor intentionally disabled tokens including numeric Splunk flags', async () => {
  __setSplunkTransport(async url => entity({ version: '10.4.0', disabled: url.includes('/managed?') ? 1 : 0 }))
  try {
    const canvas = { sections: [{ fields: { name: 'managed', enabled: false } }] }
    assert.equal((await hecHealth(context({ canvas }))).healthy, true)
    canvas.sections[0].fields.enabled = true
    assert.equal((await hecHealth(context({ canvas }))).healthy, false)
  } finally { __setSplunkTransport(null) }
})


test('required cluster distribution fails before any REST install when remote execution is unavailable', async () => {
  let calls = 0
  __setSplunkTransport(async () => { calls++; return response({}) })
  try {
    const canvas = { name: 'managed', sections: [{ fields: { name: 'managed', source: 'inline', cmInstallDirs: ['etc/manager-apps'] } }] }
    const result = await deployApps(context({ component: { ...component, type: ['cluster-manager'] }, canvas }))
    assert.equal(result.success, false); assert.match(result.message, /Managed ZTNA/); assert.equal(calls, 0)
  } finally { __setSplunkTransport(null) }
})


test('malformed successful reads cannot produce healthy or clean app/HEC/pool status', async () => {
  __setSplunkTransport(async () => response({}))
  try {
    for (const health of [appHealth, hecHealth, poolHealth, tokenHealth]) assert.equal((await health(context())).healthy, false)
    for (const drift of [appDrift, hecDrift, poolDrift]) assert.equal((await drift(context())).hasDrift, true)
    assert.equal((await tokenDeploy(context())).success, false)
  } finally { __setSplunkTransport(null) }
})


test('rollback preserves pre-existing staging content even if the app was absent from etc/apps', async () => {
  const remoteCalls: string[] = []
  __setSplunkTransport(async () => response({}))
  try {
    const result = await appRollback(context({ rollbackData: { previousState: [{ name: 'managed', existed: false }], stagingPlaced: [{ appId: 'managed', role: 'cluster-manager', dir: 'etc/manager-apps', existed: true }] }, remote: { homeDir: '/opt/splunk', run: async (intent: any) => { remoteCalls.push(intent.action); return { ok: true } } } }))
    assert.equal(result.success, false); assert.deepEqual(remoteCalls, [])
  } finally { __setSplunkTransport(null) }
})


test('staging provenance is captured before a partial extraction fails', async () => {
  __setSplunkTransport(async (_url, init) => (init.method ?? 'GET') === 'GET' ? response({}, 404) : response({}))
  try {
    const canvas = { name: 'managed', version: 1, sections: [{ fields: { name: 'managed', source: 'inline', cmInstallDirs: ['etc/manager-apps'] } }] }
    const remote = { homeDir: '/opt/splunk', putFile: async () => {}, hashTree: async () => [{ path: 'default/app.conf', sha256: 'old' }], extractArchive: async () => { throw new Error('partial extraction') }, run: async () => ({ ok: true }) }
    const result = await deployApps(context({ canvas, component: { ...component, type: ['cluster-manager'] }, remote }))
    assert.equal(result.success, false)
    assert.deepEqual((result.rollbackData as any).stagingPlaced, [{ appId: 'managed', role: 'cluster-manager', dir: 'etc/manager-apps', existed: true }])
  } finally { __setSplunkTransport(null) }
})
