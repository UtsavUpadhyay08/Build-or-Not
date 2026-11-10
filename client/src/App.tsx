import { Routes, Route, Link } from "react-router-dom";
import { GamePage } from "./game/GamePage";
import { HistoryList } from "./components/HistoryList";

function HistoryPage() {
  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="brand">
          <span className="brand-mark">IP</span>
          <span>Build or Not</span>
        </Link>
        <Link to="/" className="topbar-sub">
          ← Back to the village
        </Link>
      </header>
      <main className="main">
        <HistoryList />
      </main>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<GamePage />} />
      <Route path="/ideas/:id" element={<GamePage />} />
      <Route path="/history" element={<HistoryPage />} />
    </Routes>
  );
}
