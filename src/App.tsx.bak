import { Routes, Route, Navigate } from 'react-router-dom'
import GrowDashboard from './pages/GrowDashboard'

export default function App() {
  return (
    <Routes>
      <Route path="/grow" element={<GrowDashboard />} />
      <Route path="*" element={<Navigate to="/grow" replace />} />
    </Routes>
  )
}
