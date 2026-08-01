import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'github-advanced-security',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/github-advanced-security/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/github-advanced-security/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/github-advanced-security/connections', label: 'Connections', icon: 'link' },
  ],
}
