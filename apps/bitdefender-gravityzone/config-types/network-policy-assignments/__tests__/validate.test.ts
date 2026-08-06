import validate from '../validate'
import { extractPolicyAssignmentSpecs } from '../_shared'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'bitdefender-gravityzone',
    customerId: 'cust-1',
    configTypeId: 'network-policy-assignments',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'bitdefender-gravityzone',
      entityType: 'network-policy-assignments',
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

describe('GravityZone Network Policy Assignments Validate Handler', () => {
  it('returns invalid for empty items', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('EMPTY')
  })

  it('validates a well-formed explicit assignment', async () => {
    const result = await validate(makeCtx([{ name: 'a1', fields: { assignmentName: 'Servers', targetIds: 'ep-1,ep-2', policyId: 'pol-1' } }]))
    expect(result.valid).toBe(true)
  })

  it('validates a well-formed inherited assignment', async () => {
    const result = await validate(makeCtx([{ name: 'a1', fields: { assignmentName: 'Servers', targetIds: 'ep-1', inheritFromAbove: true } }]))
    expect(result.valid).toBe(true)
  })

  it('requires targetIds', async () => {
    const result = await validate(makeCtx([{ name: 'a1', fields: { assignmentName: 'Servers', policyId: 'pol-1' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.targetIds'))).toBe(true)
  })

  it('requires a policyId unless inheriting', async () => {
    const result = await validate(makeCtx([{ name: 'a1', fields: { assignmentName: 'Servers', targetIds: 'ep-1' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.policyId'))).toBe(true)
  })

  it('rejects policyId combined with inheritFromAbove', async () => {
    const result = await validate(makeCtx([{ name: 'a1', fields: { assignmentName: 'Servers', targetIds: 'ep-1', policyId: 'pol-1', inheritFromAbove: true } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'MUTUALLY_EXCLUSIVE')).toBe(true)
  })

  it('rejects forcePolicyInheritance combined with inheritFromAbove', async () => {
    const result = await validate(makeCtx([{ name: 'a1', fields: { assignmentName: 'Servers', targetIds: 'ep-1', inheritFromAbove: true, forcePolicyInheritance: true } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'MUTUALLY_EXCLUSIVE')).toBe(true)
  })
})

describe('GravityZone Network Policy Assignments shared helpers', () => {
  it('extractPolicyAssignmentSpecs reads and splits targetIds', () => {
    const specs = extractPolicyAssignmentSpecs(makeCtx([{ name: 'a', fields: { assignmentName: 'S', targetIds: 'ep-1, ep-2 ,ep-3', policyId: 'pol-1' } }]).canvas)
    expect(specs[0].targetIds).toEqual(['ep-1', 'ep-2', 'ep-3'])
    expect(specs[0].policyId).toBe('pol-1')
    expect(specs[0].inheritFromAbove).toBe(false)
  })
})
