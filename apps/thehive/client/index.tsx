import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'thehive',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/thehive/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/thehive/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/thehive/connections', label: 'Connections', icon: 'link' },
  ],
}
