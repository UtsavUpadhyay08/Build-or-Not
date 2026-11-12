import { useEffect, useState } from "react";

/**
 * "Fix my idea" doesn't wait at the bottom of the results to be found. When a run's result arrives
 * it pops up in the corner once, then shrinks into a small corner button that stays until the fix
 * plan is on screen. Shown to the run's owner only: browsing other people's ideas stays quiet.
 */
export function FixNudge({ ideaId, verdict, hidden, onFix }: { ideaId: string; verdict: "build" | "maybe" | "dont_build"; hidden: boolean; onFix: () => void }) {
  const key = `bon.fixNudged.${ideaId}`;
  // First time for this run: pop up. Seen it before: straight to the corner button.
  const [mode, setMode] = useState<"wait" | "pop" | "pill">(() => (seen(key) ? "pill" : "wait"));

  useEffect(() => {
    if (mode !== "wait") return;
    const t = setTimeout(() => {
      setMode("pop");
      remember(key);
    }, 1800); // let the result banner land first
    return () => clearTimeout(t);
  }, [mode, key]);

  useEffect(() => {
    if (mode !== "pop") return;
    const t = setTimeout(() => setMode("pill"), 9000); // tuck into the corner by itself
    return () => clearTimeout(t);
  }, [mode]);

  if (mode === "wait" || hidden) return null;
  const build = verdict === "build";

  if (mode === "pop")
    return (
      <aside className="fix-nudge fix-pop" role="complementary" aria-label="Fix your idea">
        <span aria-hidden="true" className="fix-spark">
          ✦
        </span>
        <div className="fix-pop-body">
          <strong>{build ? "Make it a 10" : "45 reviewers told you how to fix it"}</strong>
          <span>{build ? "See the small changes that would win over the rest of the council." : "One click turns their asks into the few small changes that win the most of them over."}</span>
          <div className="fix-pop-actions">
            <button type="button" className="gbtn gbtn-sm" onClick={onFix}>
              Fix my idea with AI
            </button>
            <button type="button" className="fix-later" onClick={() => setMode("pill")}>
              Later
            </button>
          </div>
        </div>
      </aside>
    );

  return (
    <button type="button" className="fix-nudge fix-pill" onClick={onFix} aria-label="Fix my idea with AI">
      <span aria-hidden="true" className="fix-spark">
        ✦
      </span>
      <span>Fix my idea</span>
    </button>
  );
}

function seen(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}
function remember(key: string) {
  try {
    localStorage.setItem(key, "1");
  } catch {
    /* storage blocked: it may pop up again next time, that's all */
  }
}
