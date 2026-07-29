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
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.email ?? i), fields }))
}

function deployCtx(fields: Array<Record<string, unknown>>, remote: RemoteExecutor | undefined): DeployContext {
  return {
    appId: 'security-onion',
    customerId: 'c1',
    configTypeId: 'soc-users',
    canvas: {
      id: 's1', canvasId: 'cv1', version: 1, name: 'n', toolType: 'security-onion',
      entityType: 'soc-users', items: toItems(fields), sections: toItems(fields), snapshot: {},
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

test('deploy applies so-user per item then a salt highstate', async () => {
  const { remote, calls } = recordingRemote()
  const res = await deploy(deployCtx([{ email: 'analyst@example.com', action: 'disable' }, { email: 'admin@example.com', action: 'enable' }], remote))
  assert.equal(res.success, true)
  assert.deepEqual(
    calls.filter((c) => c.id === 'so-user').map((c) => c.params),
    [{ action: 'disable', email: 'analyst@example.com' }, { action: 'enable', email: 'admin@example.com' }],
  )
  assert.ok(calls.some((c) => c.id === 'salt-highstate'), 'runs highstate after applying users')
  assert.deepEqual((res.rollbackData as { applied: unknown }).applied, [
    { email: 'analyst@example.com', action: 'disable' },
    { email: 'admin@example.com', action: 'enable' },
  ])
})

test('deploy without managed connectivity fails with a clear message', async () => {
  const res = await deploy(deployCtx([{ email: 'analyst@example.com', action: 'disable' }], undefined))
  assert.equal(res.success, false)
  assert.match(res.message, /managed connectivity/)
})

test('rollback applies the inverse state per user', async () => {
  const { remote, calls } = recordingRemote()
  const ctx = { remote, rollbackData: { applied: [{ email: 'analyst@example.com', action: 'disable' }] } } as unknown as RollbackContext
  const res = await rollback(ctx)
  assert.equal(res.success, true)
  assert.deepEqual(calls.find((c) => c.id === 'so-user')?.params, { action: 'enable', email: 'analyst@example.com' })
})

test('validate rejects a bad email and an unknown state', async () => {
  const ctx = { canvas: { items: toItems([{ email: 'not-an-email', action: 'nuke' }]) } } as unknown as PipelineContext
  const res = await validate(ctx)
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_EMAIL'))
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ACTION'))
})
