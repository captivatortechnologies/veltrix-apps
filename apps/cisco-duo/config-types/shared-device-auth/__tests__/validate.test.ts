import validate, {
  extractSharedDeviceAuthSpecs,
  liveGroupIds,
  liveTrustedEndpointIntegrationIds,
  MAX_NAME_LENGTH,
} from '../validate'
import { buildSharedDeviceAuthBody } from '../deploy'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('shared-device-auth validate', () => {
  it('accepts a valid configuration', () => {
    const r = validate(
      ctxWith([{ name: 'a', fields: { name: 'Help Center 1', group_ids: 'DG1', trusted_endpoint_integration_ids: 'DM1' } }])
    )
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { group_ids: 'DG1', trusted_endpoint_integration_ids: 'DM1' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.name'))).toBe(true)
  })

  it('requires at least one group id', () => {
    const r = validate(ctxWith([{ name: 'a', fields: { name: 'x', trusted_endpoint_integration_ids: 'DM1' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.group_ids'))).toBe(true)
  })

  it('requires at least one trusted endpoint integration id', () => {
    const r = validate(ctxWith([{ name: 'a', fields: { name: 'x', group_ids: 'DG1' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.trusted_endpoint_integration_ids'))).toBe(true)
  })

  it('rejects duplicate names (case-insensitive)', () => {
    const r = validate(
      ctxWith([
        { name: 'a', fields: { name: 'Dup', group_ids: 'DG1', trusted_endpoint_integration_ids: 'DM1' } },
        { name: 'b', fields: { name: 'dup', group_ids: 'DG2', trusted_endpoint_integration_ids: 'DM2' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('enforces the name length limit', () => {
    const r = validate(
      ctxWith([{ name: 'a', fields: { name: 'x'.repeat(MAX_NAME_LENGTH + 1), group_ids: 'DG1', trusted_endpoint_integration_ids: 'DM1' } }])
    )
    expect(r.errors.some((e) => e.code === 'too_long')).toBe(true)
  })
})

describe('extractSharedDeviceAuthSpecs', () => {
  it('reads fields, trimming, parsing id lists and defaulting active to true', () => {
    const specs = extractSharedDeviceAuthSpecs({
      items: [
        {
          id: 'i1',
          name: 'Fallback',
          fields: { name: '  Real  ', group_ids: 'DG1, DG2', trusted_endpoint_integration_ids: 'DM1\nDM2' },
        },
      ],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0]).toEqual({
      itemId: 'i1',
      name: 'Real',
      active: true,
      groupIds: ['DG1', 'DG2'],
      trustedEndpointIntegrationIds: ['DM1', 'DM2'],
    })
  })

  it('honors an explicit active=false', () => {
    const specs = extractSharedDeviceAuthSpecs({
      items: [{ id: 'i1', name: 'x', fields: { name: 'x', active: false, group_ids: 'DG1', trusted_endpoint_integration_ids: 'DM1' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].active).toBe(false)
  })
})

describe('liveGroupIds / liveTrustedEndpointIntegrationIds', () => {
  it('normalizes ids from live response objects and bare strings', () => {
    expect(liveGroupIds({ groups: [{ group_id: 'DG1', name: 'x' }, 'DG2'] })).toEqual(['DG1', 'DG2'])
    expect(
      liveTrustedEndpointIntegrationIds({ trusted_endpoint_integrations: [{ trusted_endpoint_integration_id: 'DM1' }] })
    ).toEqual(['DM1'])
  })

  it('returns an empty list when the live field is absent', () => {
    expect(liveGroupIds({})).toEqual([])
    expect(liveTrustedEndpointIntegrationIds({})).toEqual([])
  })
})

describe('buildSharedDeviceAuthBody', () => {
  it('builds the V5 JSON body, coercing active to 1/0', () => {
    expect(
      buildSharedDeviceAuthBody({
        itemId: 'i1',
        name: 'Help Center 1',
        active: true,
        groupIds: ['DG1', 'DG2'],
        trustedEndpointIntegrationIds: ['DM1'],
      })
    ).toEqual({
      name: 'Help Center 1',
      active: 1,
      group_id_list: ['DG1', 'DG2'],
      trusted_endpoint_integration_id_list: ['DM1'],
    })

    expect(
      buildSharedDeviceAuthBody({ name: 'x', active: false, groupIds: [], trustedEndpointIntegrationIds: [] })
    ).toEqual({ name: 'x', active: 0, group_id_list: [], trusted_endpoint_integration_id_list: [] })
  })
})
