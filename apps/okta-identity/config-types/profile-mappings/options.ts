// Options provider for the Profile Mappings config type — thin re-export of the
// shared provider so this type's remote-select fields resolve their live options
// (Source/Target via the mappingEndpoints source: user types + apps).
export { default } from '../lib/oktaOptions'
