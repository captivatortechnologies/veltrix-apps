import validate from '../validate'
import { buildAccountRecord } from '../_shared'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'splunk-soar',
    customerId: 'cust-1',
    configTypeId: 'automation-accounts',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'splunk-soar',
      entityType: 'automation-accounts',
      items,
      sections: items,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
  }
}

describe('Splunk SOAR Automation Accounts', () => {
  it('validates a minimal automation account', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { username: 'svc_veltrix' } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects a missing username', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'EMPTY_ID')).toBe(true)
  })

  it('buildAccountRecord always fixes type to automation and never sends a password', () => {
    const spec = buildAccountRecord({ username: 'svc_veltrix', roles: ['Automation'] })
    expect(spec.body?.type).toBe('automation')
    expect(spec.body?.password).toBeUndefined()
  })

  it('buildAccountRecord includes optional fields only when set', () => {
    const spec = buildAccountRecord({ username: 'svc_veltrix' })
    expect(spec.body?.email).toBeUndefined()
    expect(spec.body?.default_tenant_id).toBeUndefined()
  })

  it('buildAccountRecord parses allowed_ips and roles as lists', () => {
    const spec = buildAccountRecord({ username: 'svc', allowed_ips: '10.10.0.0/16, 10.20.0.0/16', roles: ['Automation'] })
    expect(spec.body?.allowed_ips).toEqual(['10.10.0.0/16', '10.20.0.0/16'])
    expect(spec.body?.roles).toEqual(['Automation'])
  })

  it('buildAccountRecord includes default_tenant_id when provided', () => {
    const spec = buildAccountRecord({ username: 'svc', default_tenant_id: 5 })
    expect(spec.body?.default_tenant_id).toBe(5)
  })
})
