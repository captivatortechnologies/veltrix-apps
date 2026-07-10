// =============================================================================
// Splunk SOAR App — Client Entry Point
//
// Registers the app's pages and sidebar items. The platform dynamically
// loads this module when the app is enabled for a customer.
// =============================================================================

import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))

export default {
  id: 'splunk-soar',
  pages: {
    OverviewPage,
    SetupGuidePage,
  },
  sidebarItems: [
    { path: '/apps/splunk-soar/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/splunk-soar/setup', label: 'Setup Guide', icon: 'book' },
  ],
}
