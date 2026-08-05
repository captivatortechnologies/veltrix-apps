import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'sophos-central',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/sophos-central/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/sophos-central/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/sophos-central/connections', label: 'Connections', icon: 'link' },
  ],
}
