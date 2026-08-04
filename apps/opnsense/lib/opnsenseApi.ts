// =============================================================================
// Barrel re-export. This file used to hold the entire OPNsense API client;
// as of Wave 3 it is split by API family (see CLAUDE.md's file-size
// guidance) into lib/opnsenseCore.ts (transport, credentials, the generic
// buildModelResource factory, and the two shared "apply" idioms) plus one
// file per resource family. Every existing config type imports from this
// exact path, so it stays a pure re-export — nothing here changes behavior.
//
// New config types (Wave 3 onward) may import directly from the specific
// resource file (e.g. `lib/oneToOneNatApi.ts`) instead of this barrel; both
// resolve to the same implementation.
// =============================================================================

export * from './opnsenseCore'
export * from './aliasApi'
export * from './categoryApi'
export * from './filterRuleApi'
export * from './sourceNatApi'
export * from './oneToOneNatApi'
export * from './unboundApi'
export * from './trafficShaperApi'
export * from './staticRoutesApi'
