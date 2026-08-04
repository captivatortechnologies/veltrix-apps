import {
  CLASSIFIER_TYPE,
  isClassifierType,
  isMapperType,
  isProtectedClassification,
  mapperDirectionOf,
  MAPPER_TYPE_BY_DIRECTION,
  parseConfigBlob,
  type LiveClassification,
} from '../xsoarClassification'

describe('xsoarClassification shared plumbing', () => {
  it('isClassifierType matches only "classification"', () => {
    expect(isClassifierType(CLASSIFIER_TYPE)).toBe(true)
    expect(isClassifierType('mapping-incoming')).toBe(false)
    expect(isClassifierType(undefined)).toBe(false)
  })

  it('isMapperType matches either mapper direction', () => {
    expect(isMapperType(MAPPER_TYPE_BY_DIRECTION.incoming)).toBe(true)
    expect(isMapperType(MAPPER_TYPE_BY_DIRECTION.outgoing)).toBe(true)
    expect(isMapperType(CLASSIFIER_TYPE)).toBe(false)
    expect(isMapperType(undefined)).toBe(false)
  })

  it('mapperDirectionOf reads the direction out of the type value', () => {
    expect(mapperDirectionOf('mapping-incoming')).toBe('incoming')
    expect(mapperDirectionOf('mapping-outgoing')).toBe('outgoing')
    expect(mapperDirectionOf(CLASSIFIER_TYPE)).toBeNull()
    expect(mapperDirectionOf(undefined)).toBeNull()
  })

  it('isProtectedClassification is true for a system or locked object', () => {
    const item: LiveClassification = { system: true }
    expect(isProtectedClassification(item)).toBe(true)
    expect(isProtectedClassification({ locked: true })).toBe(true)
    expect(isProtectedClassification({ system: false, locked: false })).toBe(false)
  })

  it('parseConfigBlob treats blank input as an empty object', () => {
    const result = parseConfigBlob('   ')
    expect(result.error).toBeNull()
    expect(result.value).toEqual({})
  })

  it('parseConfigBlob parses a valid JSON object', () => {
    const result = parseConfigBlob('{"keyTypeMap": {"a": "b"}}')
    expect(result.error).toBeNull()
    expect(result.value).toEqual({ keyTypeMap: { a: 'b' } })
  })

  it('parseConfigBlob errors on malformed JSON', () => {
    const result = parseConfigBlob('{not json')
    expect(result.error).toBe('must be valid JSON')
  })

  it('parseConfigBlob errors on a JSON array (must be an object)', () => {
    const result = parseConfigBlob('[1,2,3]')
    expect(result.error).toBe('must be a JSON object')
  })
})
