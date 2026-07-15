import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))

export default {
  id: 'elastic-security',
  pages: { OverviewPage, SetupGuidePage },
  sidebarItems: [
    { path: '/apps/elastic-security/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/elastic-security/setup', label: 'Setup Guide', icon: 'book' },
  ],
}
