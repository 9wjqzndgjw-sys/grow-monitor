// Drop-in replacement for src/App.tsx — adds the /pid route.
// The existing /grow route + catch-all are unchanged.

import { Routes, Route, Navigate } from 'react-router-dom'
import GrowDashboard from './pages/GrowDashboard'
import PidTuner from './pages/PidTuner'

export default function App() {
  return (
    <Routes>
      <Route path="/grow" element={<GrowDashboard />} />
      <Route path="/pid"  element={<PidTuner />} />
      <Route path="*"     element={<Navigate to="/grow" replace />} />
    </Routes>
  )
}