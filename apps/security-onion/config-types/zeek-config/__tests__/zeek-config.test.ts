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
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.logType ?? i), fields }))
}

function deployCtx(fields: Array<Record<string, unknown>>, remote: RemoteExecutor | undefined): DeployContext {
  return {
    appId: 'security-onion',
    customerId: 'c1',
    configTypeId: 'zeek-config',
    canvas: {
      id: 's1', canvasId: 'cv1', version: 1, name: 'n', toolType: 'security-onion',
      entityType: 'zeek-config', items: toItems(fields), sections: toItems(fields), snapshot: {},
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

test('deploy applies zeek-toggle per item then a salt highstate', async () => {
  const { remote, calls } = recordingRemote()
  const res = await deploy(deployCtx([{ logType: 'http', action: 'enable' }, { logType: 'ssl', action: 'disable' }], remote))
  assert.equal(res.success, true)
  assert.deepEqual(
    calls.filter((c) => c.id === 'zeek-toggle').map((c) => c.params),
    [{ action: 'enable', logtype: 'http' }, { action: 'disable', logtype: 'ssl' }],
  )
  assert.ok(calls.some((c) => c.id === 'salt-highstate'), 'runs highstate after applying log types')
  assert.deepEqual((res.rollbackData as { applied: unknown }).applied, [
    { logType: 'http', action: 'enable' },
    { logType: 'ssl', action: 'disable' },
  ])
})

test('deploy without managed connectivity fails with a clear message', async () => {
  const res = await deploy(deployCtx([{ logType: 'http', action: 'enable' }], undefined))
  assert.equal(res.success, false)
  assert.match(res.message, /managed connectivity/)
})

test('rollback applies the inverse state per log type', async () => {
  const { remote, calls } = recordingRemote()
  const ctx = { remote, rollbackData: { applied: [{ logType: 'ssl', action: 'disable' }] } } as unknown as RollbackContext
  const res = await rollback(ctx)
  assert.equal(res.success, true)
  assert.deepEqual(calls.find((c) => c.id === 'zeek-toggle')?.params, { action: 'enable', logtype: 'ssl' })
})

test('validate rejects an uppercase/invalid log type and an unknown state', async () => {
  const ctx = { canvas: { items: toItems([{ logType: 'HTTP', action: 'nuke' }]) } } as unknown as PipelineContext
  const res = await validate(ctx)
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_LOGTYPE'))
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ACTION'))
})
