import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'cisco-ise',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/cisco-ise/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/cisco-ise/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/cisco-ise/connections', label: 'Connections', icon: 'link' },
  ],
}
