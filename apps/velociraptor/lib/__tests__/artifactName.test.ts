import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ARTIFACT_NAME_RE, validArtifactName } from '../artifactName'

test('validArtifactName accepts dotted alphanumeric artifact names', () => {
  assert.equal(validArtifactName('Custom.Windows.Detection.Foo'), true)
  assert.equal(validArtifactName('Windows.Events.ProcessCreation'), true)
  assert.equal(validArtifactName('Server.Monitor.Health'), true)
  assert.equal(validArtifactName('Foo'), true)
})

test('validArtifactName trims surrounding whitespace before matching', () => {
  assert.equal(validArtifactName('  Custom.Foo  '), true)
})

test('validArtifactName rejects malformed names', () => {
  assert.equal(validArtifactName(''), false)
  assert.equal(validArtifactName('bad name'), false)
  assert.equal(validArtifactName('bad!name'), false)
  assert.equal(validArtifactName('.Leading.Dot'), false)
  assert.equal(validArtifactName('Trailing.Dot.'), false)
  assert.equal(validArtifactName('Double..Dot'), false)
  assert.equal(validArtifactName('1StartsWithDigit'), false)
})

test('ARTIFACT_NAME_RE matches the same rule directly', () => {
  assert.equal(ARTIFACT_NAME_RE.test('Custom.Foo.Bar1'), true)
  assert.equal(ARTIFACT_NAME_RE.test('Custom Foo'), false)
})
