import { Routes, Route } from "react-router-dom";
import { GamePage } from "./game/GamePage";
import { HistoryPage } from "./history/HistoryPage";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<GamePage />} />
      <Route path="/ideas/:id" element={<GamePage />} />
      <Route path="/history" element={<HistoryPage />} />
    </Routes>
  );
}
