import {
  buildFieldBody,
  buildFieldId,
  CLI_NAME_RE,
  extractFieldSpecs,
  fieldIdPrefix,
  fieldKindOf,
  fieldsOfKind,
  FIELD_GROUP_BY_KIND,
  FIELD_TYPES_BY_KIND,
  isProtectedField,
  RESERVED_CLI_NAMES_BY_KIND,
  type LiveField,
} from '../xsoarFields'
import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'

function makeCanvas(sections: Array<{ name: string; fields: Record<string, unknown> }>): CanvasSnapshot {
  return {
    id: 'snap-1',
    canvasId: 'canvas-1',
    version: 1,
    name: 'Test Canvas',
    toolType: 'cortex-xsoar',
    entityType: 'xsoar-incident-fields',
    items: sections,
    sections,
    snapshot: {},
  }
}

describe('xsoarFields shared plumbing', () => {
  it('fieldIdPrefix / buildFieldId derive the server id from kind + cliName', () => {
    expect(fieldIdPrefix('incident')).toBe('incident_')
    expect(fieldIdPrefix('indicator')).toBe('indicator_')
    expect(buildFieldId('incident', 'sourceip')).toBe('incident_sourceip')
    expect(buildFieldId('indicator', 'eventtype')).toBe('indicator_eventtype')
  })

  it('fieldKindOf reads the kind from the id prefix, case-insensitively', () => {
    expect(fieldKindOf({ id: 'incident_xdrincidentid' })).toBe('incident')
    expect(fieldKindOf({ id: 'INDICATOR_eventtype' })).toBe('indicator')
    expect(fieldKindOf({ id: 'evidence_something' })).toBeNull()
    expect(fieldKindOf({})).toBeNull()
  })

  it('fieldsOfKind filters a mixed listing down to one kind', () => {
    const fields: LiveField[] = [
      { id: 'incident_a', group: 0 },
      { id: 'indicator_b', group: 2 },
      { id: 'incident_c', group: 0 },
    ]
    expect(fieldsOfKind(fields, 'incident').map((f) => f.id)).toEqual(['incident_a', 'incident_c'])
    expect(fieldsOfKind(fields, 'indicator').map((f) => f.id)).toEqual(['indicator_b'])
  })

  it('isProtectedField is true for a system or locked field', () => {
    expect(isProtectedField({ system: true })).toBe(true)
    expect(isProtectedField({ locked: true })).toBe(true)
    expect(isProtectedField({ system: false, locked: false })).toBe(false)
  })

  it('CLI_NAME_RE accepts lowercase alphanumeric only', () => {
    expect(CLI_NAME_RE.test('sourceip2')).toBe(true)
    expect(CLI_NAME_RE.test('Source_IP')).toBe(false)
    expect(CLI_NAME_RE.test('source-ip')).toBe(false)
    expect(CLI_NAME_RE.test('')).toBe(false)
  })

  it('RESERVED_CLI_NAMES_BY_KIND blocks XSOAR-reserved internal columns', () => {
    expect(RESERVED_CLI_NAMES_BY_KIND.incident.has('name')).toBe(true)
    expect(RESERVED_CLI_NAMES_BY_KIND.indicator.has('score')).toBe(true)
    expect(RESERVED_CLI_NAMES_BY_KIND.incident.has('sourceip')).toBe(false)
  })

  it('FIELD_TYPES_BY_KIND excludes incident-only types from indicator fields', () => {
    expect(FIELD_TYPES_BY_KIND.incident).toContain('attachments')
    expect(FIELD_TYPES_BY_KIND.indicator.includes('attachments')).toBe(false)
    expect(FIELD_TYPES_BY_KIND.indicator.includes('internal')).toBe(false)
    expect(FIELD_TYPES_BY_KIND.indicator.includes('timer')).toBe(false)
  })

  it('extractFieldSpecs reads and lowercases cliName, defaults associatedToAll to true', () => {
    const specs = extractFieldSpecs(
      makeCanvas([{ name: 's', fields: { cliName: 'SourceIP', name: 'Source IP', type: 'shortText' } }]),
    )
    expect(specs[0].cliName).toBe('sourceip')
    expect(specs[0].associatedToAll).toBe(true)
    expect(specs[0].associatedTypes).toEqual([])
  })

  it('extractFieldSpecs reads associatedTypes when associatedToAll is false', () => {
    const specs = extractFieldSpecs(
      makeCanvas([
        {
          name: 's',
          fields: {
            cliName: 'sourceip',
            name: 'Source IP',
            type: 'shortText',
            associatedToAll: false,
            associatedTypes: ['Phishing', 'Malware'],
          },
        },
      ]),
    )
    expect(specs[0].associatedToAll).toBe(false)
    expect(specs[0].associatedTypes).toEqual(['Phishing', 'Malware'])
  })

  it('buildFieldBody derives id, sets the kind group, and clears associatedTypes when associated to all', () => {
    const body = buildFieldBody(
      'incident',
      {
        sectionName: 's',
        cliName: 'sourceip',
        name: 'Source IP',
        type: 'shortText',
        required: true,
        associatedToAll: true,
        associatedTypes: ['ignored-when-associated-to-all'],
      },
      null,
    )
    expect(body.id).toBe('incident_sourceip')
    expect(body.group).toBe(FIELD_GROUP_BY_KIND.incident)
    expect(body.associatedTypes).toEqual([])
    expect(body.version).toBe(-1)
  })

  it('buildFieldBody carries the live version forward on update', () => {
    const body = buildFieldBody(
      'indicator',
      {
        sectionName: 's',
        cliName: 'eventtype',
        name: 'Event Type',
        type: 'shortText',
        required: false,
        associatedToAll: false,
        associatedTypes: ['CVE'],
      },
      { id: 'indicator_eventtype', version: 7 },
    )
    expect(body.version).toBe(7)
    expect(body.associatedTypes).toEqual(['CVE'])
    expect(body.group).toBe(FIELD_GROUP_BY_KIND.indicator)
  })
})
