import { IdeaForm } from "./IdeaForm";
import { HistoryList } from "./HistoryList";

export function HomePage() {
  return (
    <div className="home">
      <IdeaForm />
      <HistoryList />
    </div>
  );
}
