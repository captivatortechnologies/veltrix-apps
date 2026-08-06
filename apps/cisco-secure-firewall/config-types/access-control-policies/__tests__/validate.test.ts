import validate, { extractAccessControlPolicySpecs, buildAccessControlPolicyFields, accessControlPolicyDriftDiffs } from '../validate'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cisco-secure-firewall',
    customerId: 'cust-1',
    configTypeId: 'access-control-policies',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cisco-secure-firewall',
      entityType: 'access-control-policies',
      items: sections,
      sections,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
  }
}

function makeCanvas(sections: Array<{ name: string; fields: Record<string, unknown> }>): CanvasSnapshot {
  return {
    id: 's',
    canvasId: 'c',
    version: 1,
    name: 'n',
    toolType: 'cisco-secure-firewall',
    entityType: 'access-control-policies',
    items: sections,
    sections,
    snapshot: {},
  }
}

describe('Access Control Policies validate handler', () => {
  it('returns invalid for an empty canvas', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal policy', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'corp-policy', default_action: 'BLOCK' } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects an unsupported default action', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'corp-policy', default_action: 'ALLOW' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_default_action')).toBe(true)
  })

  it('rejects a duplicate policy name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'corp-policy', default_action: 'BLOCK' } },
        { name: 'sec2', fields: { name: 'corp-policy', default_action: 'TRUST' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate')).toBe(true)
  })
})

describe('extractAccessControlPolicySpecs / buildAccessControlPolicyFields', () => {
  it('defaults default_action to BLOCK when blank and nests fields under defaultAction', () => {
    const specs = extractAccessControlPolicySpecs(makeCanvas([{ name: 'sec1', fields: { name: 'corp-policy' } }]))
    expect(specs[0].defaultAction).toBe('BLOCK')
    expect(buildAccessControlPolicyFields(specs[0])).toEqual({
      defaultAction: { action: 'BLOCK', logBegin: false, logEnd: false, sendEventsToFMC: false },
    })
  })
})

describe('accessControlPolicyDriftDiffs', () => {
  it('flags a changed default action', () => {
    const spec = { sectionName: 's', name: 'corp-policy', description: '', defaultAction: 'BLOCK', logBegin: false, logEnd: false, sendEventsToFmc: false }
    const diffs = accessControlPolicyDriftDiffs(spec, { defaultAction: { action: 'TRUST', logBegin: false, logEnd: false } })
    expect(diffs.some((d) => d.field === 'corp-policy.default_action')).toBe(true)
  })

  it('reports no drift when everything matches', () => {
    const spec = { sectionName: 's', name: 'corp-policy', description: '', defaultAction: 'BLOCK', logBegin: false, logEnd: false, sendEventsToFmc: false }
    const diffs = accessControlPolicyDriftDiffs(spec, { defaultAction: { action: 'BLOCK', logBegin: false, logEnd: false, sendEventsToFMC: false } })
    expect(diffs).toHaveLength(0)
  })
})
