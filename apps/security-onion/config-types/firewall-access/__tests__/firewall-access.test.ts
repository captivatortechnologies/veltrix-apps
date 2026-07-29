import { test } from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import rollback from '../rollback'
import validate from '../validate'
import type { DeployContext, RollbackContext, PipelineContext, RemoteExecutor } from '@veltrixsecops/app-sdk'

function recordingRemote() {
  const calls: Array<{ id: string; params: Record<string, unknown> }> = []
  const remote = {
    homeDir: '/opt/so',
    async command(id: string, params: Record<string, unknown> = {}) {
      calls.push({ id, params })
      return { ok: true, code: 0, stdout: '', stderr: '' }
    },
    async run() { return { ok: true, code: 0, stdout: '', stderr: '' } },
    async extractArchive() {},
    async putFile() {},
    async hashTree() { return [] },
    async readFile() { return '' },
  } as unknown as RemoteExecutor
  return { remote, calls }
}

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.host ?? i), fields }))
}

function deployCtx(fields: Array<Record<string, unknown>>, remote: RemoteExecutor | undefined): DeployContext {
  return {
    appId: 'security-onion',
    customerId: 'c1',
    configTypeId: 'firewall-access',
    canvas: {
      id: 's1', canvasId: 'cv1', version: 1, name: 'n', toolType: 'security-onion',
      entityType: 'firewall-access', items: toItems(fields), sections: toItems(fields), snapshot: {},
    },
    environment: { id: 'e1', name: 'production' },
    user: { id: 'u1', email: 'x@example.com', name: null },
    settings: {},
    platform: { getLatestDeployment: async () => null, listComponents: async () => [] } as unknown as DeployContext['platform'],
    component: { id: 'comp1', hostname: 'so.local', port: '443', type: ['manager'], toolId: 't1' },
    credential: { username: 'u', password: 'p' } as unknown as DeployContext['credential'],
    connectivity: null,
    connectivityProvider: null,
    remote,
    previousConfig: null,
    strategy: 'DIRECT',
  } as DeployContext
}

test('deploy maps include→includehost / exclude→excludehost then a salt highstate', async () => {
  const { remote, calls } = recordingRemote()
  const res = await deploy(deployCtx([
    { group: 'analyst', host: '10.0.0.5', action: 'include' },
    { group: 'analyst', host: '10.0.0.6', action: 'exclude' },
  ], remote))
  assert.equal(res.success, true)
  assert.deepEqual(
    calls.filter((c) => c.id === 'so-firewall').map((c) => c.params),
    [
      { action: 'includehost', group: 'analyst', host: '10.0.0.5' },
      { action: 'excludehost', group: 'analyst', host: '10.0.0.6' },
    ],
  )
  assert.ok(calls.some((c) => c.id === 'salt-highstate'), 'runs highstate after applying access')
  assert.deepEqual((res.rollbackData as { applied: unknown }).applied, [
    { group: 'analyst', host: '10.0.0.5', action: 'include' },
    { group: 'analyst', host: '10.0.0.6', action: 'exclude' },
  ])
})

test('deploy without managed connectivity fails with a clear message', async () => {
  const res = await deploy(deployCtx([{ group: 'analyst', host: '10.0.0.5', action: 'include' }], undefined))
  assert.equal(res.success, false)
  assert.match(res.message, /managed connectivity/)
})

test('rollback applies the inverse include/exclude per host', async () => {
  const { remote, calls } = recordingRemote()
  const ctx = { remote, rollbackData: { applied: [{ group: 'analyst', host: '10.0.0.5', action: 'include' }] } } as unknown as RollbackContext
  const res = await rollback(ctx)
  assert.equal(res.success, true)
  assert.deepEqual(calls.find((c) => c.id === 'so-firewall')?.params, { action: 'excludehost', group: 'analyst', host: '10.0.0.5' })
})

test('validate rejects a CIDR host and an unknown action', async () => {
  const ctx = { canvas: { items: toItems([{ group: 'analyst', host: '10.0.0.0/24', action: 'nuke' }]) } } as unknown as PipelineContext
  const res = await validate(ctx)
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'CIDR_UNSUPPORTED'))
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ACTION'))
})
