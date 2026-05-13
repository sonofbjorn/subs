import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import TeamList from './routes/TeamList'
import RosterList from './routes/RosterList'
import GameSetup from './routes/GameSetup'
import ActivePlayerSelect from './routes/ActivePlayerSelect'
import LineupDisplay from './routes/LineupDisplay'
import GamedayMode from './routes/GamedayMode'

const base = import.meta.env.BASE_URL
const basename = base === '/' ? '/' : base.replace(/\/$/, '')

export default function App() {
  return (
    <BrowserRouter basename={basename}>
      <Routes>
        <Route path="/" element={<TeamList />} />
        <Route path="/teams/:teamId" element={<RosterList />} />
        <Route path="/teams/:teamId/game-setup" element={<GameSetup />} />
        <Route path="/teams/:teamId/game-setup/select" element={<ActivePlayerSelect />} />
        <Route path="/teams/:teamId/lineup/:gameId" element={<LineupDisplay />} />
        <Route path="/teams/:teamId/gameday/:gameId" element={<GamedayMode />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
