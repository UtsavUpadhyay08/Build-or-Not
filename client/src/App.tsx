import { useEffect, useRef } from "react";
import { Routes, Route, useLocation } from "react-router-dom";
import { recordVisit } from "./api";
import { GamePage } from "./game/GamePage";
import { HistoryPage } from "./history/HistoryPage";
import { StatsPage } from "./stats/StatsPage";

/** Count one visit per page the visitor opens (the site they came from is only sent on the first). */
function useVisitCounter() {
  const { pathname } = useLocation();
  const last = useRef<string | null>(null);
  useEffect(() => {
    const kind = pathname.startsWith("/ideas/") ? "/ideas/" : pathname;
    if (last.current === kind) return; // the run page changes its URL mid-run; count it once
    last.current = kind;
    recordVisit(pathname);
  }, [pathname]);
}

export default function App() {
  useVisitCounter();
  return (
    <Routes>
      <Route path="/" element={<GamePage />} />
      <Route path="/ideas/:id" element={<GamePage />} />
      <Route path="/history" element={<HistoryPage />} />
      <Route path="/stats" element={<StatsPage />} />
    </Routes>
  );
}
