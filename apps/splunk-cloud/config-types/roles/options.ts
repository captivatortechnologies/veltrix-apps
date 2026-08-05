// Options provider for the Roles config type. The live-picker logic is shared
// across splunk-cloud config types, so this is a thin re-export of the shared
// provider — keeping the per-config-type handler path the platform and
// validator expect (config-types/<type>/options). Powers the "capabilities"
// optionsSource on a role's Capabilities field.
//
// Roles themselves deploy over the Splunk Cloud Platform REST API (ACS cannot
// manage identity — see validate.ts), but the capability LIST is a pure ACS
// reference lookup (GET /adminconfig/v2/capabilities) reachable with the same
// stack JWT this app already requires everywhere else, so the picker works
// even when the REST prerequisites (port 8089, search-api allow list) are not
// yet in place.
export { default } from '../lib/splunkOptions'
