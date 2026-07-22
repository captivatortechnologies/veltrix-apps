// Options provider for the HEC Tokens config type. The live-picker logic is
// shared across splunk-enterprise config types, so this is a thin re-export of
// the shared provider — keeping the per-config-type handler path the platform
// and validator expect (config-types/<type>/options). Powers the "indexes"
// optionsSource on a token's Default Index and Allowed Indexes fields.
export { default } from '../lib/splunkOptions'
