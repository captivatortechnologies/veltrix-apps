// =============================================================================
// App Client Entry Point
//
// Export one component per page declared in manifest.yaml (`client.pages[].component`).
// The platform renders the chrome around them — breadcrumb, app header, sidebar
// entry / tabs, permission gating, loading and error states — so every app
// navigates predictably. Your components render the page body.
//
// Build page bodies from @veltrixsecops/app-sdk/ui so they inherit the tenant's
// theme (light/dark) automatically. Never import platform internals.
// =============================================================================

import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'sailpoint',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/sailpoint/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/sailpoint/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/sailpoint/connections', label: 'Connections', icon: 'link' },
  ],
}
