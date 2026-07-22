// Options provider for the ThreatInsight config type. Thin re-export of the
// shared provider — keeps the per-config-type handler path the platform and
// validator expect (config-types/<type>/options). Powers the "zones"
// optionsSource on the Exempt Network Zones field.
export { default } from '../lib/oktaOptions'
