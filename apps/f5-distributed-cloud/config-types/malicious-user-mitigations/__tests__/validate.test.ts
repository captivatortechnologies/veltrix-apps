import validate, { extractMaliciousUserMitigationSpecs } from '../validate'
import { buildMaliciousUserMitigationSpecBody, stripMetadata } from '../deploy'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'f5-distributed-cloud',
    customerId: 'cust-1',
    configTypeId: 'malicious-user-mitigations',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'f5-distributed-cloud',
      entityType: 'malicious-user-mitigations',
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
    toolType: 'f5-distributed-cloud',
    entityType: 'malicious-user-mitigations',
    items: sections,
    sections,
    snapshot: {},
  }
}

describe('F5 XC Malicious User Mitigation Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal mitigation (name only, defaults apply)', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'default-mitigation' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a fully-specified mitigation', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: {
            name: 'strict-mitigation',
            lowThreatAction: 'alert_only',
            mediumThreatAction: 'captcha_challenge',
            highThreatAction: 'block_temporarily',
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an invalid name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'Not_Valid!' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_name')).toBe(true)
  })

  it('rejects a duplicate name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'default-mitigation' } },
        { name: 'sec2', fields: { name: 'default-mitigation' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('extractMaliciousUserMitigationSpecs', () => {
  it('defaults each threat-level action when unset', () => {
    const specs = extractMaliciousUserMitigationSpecs(makeCanvas([{ name: 'sec1', fields: { name: 'm1' } }]))
    expect(specs[0].lowThreatAction).toBe('alert_only')
    expect(specs[0].mediumThreatAction).toBe('javascript_challenge')
    expect(specs[0].highThreatAction).toBe('block_temporarily')
  })

  it('falls back to the default action for an unrecognized value', () => {
    const specs = extractMaliciousUserMitigationSpecs(
      makeCanvas([{ name: 'sec1', fields: { name: 'm1', highThreatAction: 'not-a-real-action' } }]),
    )
    expect(specs[0].highThreatAction).toBe('block_temporarily')
  })
})

describe('buildMaliciousUserMitigationSpecBody', () => {
  it('builds three rules, one per fixed threat level', () => {
    const specs = extractMaliciousUserMitigationSpecs(
      makeCanvas([
        {
          name: 'sec1',
          fields: { name: 'm1', lowThreatAction: 'none', mediumThreatAction: 'captcha_challenge', highThreatAction: 'block_temporarily' },
        },
      ]),
    )
    const body = buildMaliciousUserMitigationSpecBody(specs[0])
    expect(body.mitigation_type?.rules).toEqual([
      { mitigation_action: { none: true }, threat_level: { low: true } },
      { mitigation_action: { captcha_challenge: true }, threat_level: { medium: true } },
      { mitigation_action: { block_temporarily: true }, threat_level: { high: true } },
    ])
  })
})

describe('stripMetadata', () => {
  it('keeps only name/description/disable/labels/annotations', () => {
    const stripped = stripMetadata({ name: 'm1', description: 'desc', disable: true, uid: 'abc' })
    expect(stripped).toEqual({ name: 'm1', description: 'desc', disable: true, labels: undefined, annotations: undefined })
  })
})
