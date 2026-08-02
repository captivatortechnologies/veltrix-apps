// Shared Velociraptor artifact-name format check.
//
// Velociraptor artifact names are dotted, alphanumeric path segments, e.g.
// "Custom.Windows.Detection.Foo" or "Windows.Events.ProcessCreation". This same
// format applies to:
//   - the custom-artifacts config type's authored `name:` (the artifact's own
//     identity, cross-checked against the definition YAML's `name:` key), and
//   - the event-artifact names referenced (by name only, not authored here) in
//     the client-monitoring and server-monitoring artifact lists.
// Centralised here so the pattern is defined once and reused by all three.

export const ARTIFACT_NAME_RE = /^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)*$/

/** True when `name` matches Velociraptor's dotted artifact-name format. */
export function validArtifactName(name: string): boolean {
  return ARTIFACT_NAME_RE.test(name.trim())
}
