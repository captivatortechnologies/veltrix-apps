// =============================================================================
// Cybereason App — Client Entry Point
//
// Registers the app's pages and sidebar items. The platform dynamically loads
// this module when the app is enabled for a customer.
// =============================================================================

import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'cybereason',
  pages: {
    OverviewPage,
    SetupGuidePage,
    ConnectionsPage,
  },
  sidebarItems: [
    { path: '/apps/cybereason/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/cybereason/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/cybereason/connections', label: 'Connections', icon: 'link' },
  ],
}
