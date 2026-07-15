import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'elastic-security',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/elastic-security/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/elastic-security/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/elastic-security/connections', label: 'Connections', icon: 'link' },
  ],
}
