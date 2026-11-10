import { useEffect, useRef, useState } from "react";
import type { IdeaBrief } from "../types";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Ask the AI for a brief. Resolves to the brief, or throws with a readable message. */
  draft: (idea: string) => Promise<{ brief: IdeaBrief; model: string; simulated: boolean }>;
  /** Put the brief in the form; with run = true, also summon the council straight away. */
  onDone: (brief: IdeaBrief, run: boolean) => void;
  /** Which key the AI (and the run) will use, in words. */
  source: string;
  /** Why it can't run right now (no free runs left, no key yet), if it can't. */
  blocked: string | null;
  /** "Don't show this again" (the popup opens by itself on the home page otherwise). */
  hideNextTime?: boolean;
  onHideNextTime?: (off: boolean) => void;
}

const EXAMPLES = ["An app that splits rent and bills between flatmates automatically", "A Chrome extension that summarises long Slack threads", "Weekend cooking classes taught by home cooks"];

/** The "just tell me your idea" popup: one box, then the AI fills in everything else. */
export function DraftDialog({ open, onClose, draft, onDone, source, blocked, hideNextTime, onHideNextTime }: Props) {
  const [hide, setHide] = useState(!!hideNextTime);
  const [idea, setIdea] = useState("");
  const [busy, setBusy] = useState<null | "fill" | "run">(null);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const dialog = useRef<HTMLDivElement>(null);

  // Clear the old error only when the popup opens. (Clearing it on every re-render threw away the
  // message the moment the request finished, so a failed click looked like nothing happened.)
  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => box.current?.focus(), 30);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
      if (e.key === "Tab" && dialog.current) {
        // Keep keyboard focus inside the popup.
        const f = [...dialog.current.querySelectorAll<HTMLElement>("button, textarea, [href]")].filter((el) => !el.hasAttribute("disabled"));
        if (!f.length) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last.focus());
        else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus());
      }
    };
    document.addEventListener("keydown", onKey);
    return () => (clearTimeout(t), document.removeEventListener("keydown", onKey));
  }, [open, busy, onClose]);

  if (!open) return null;

  async function go(run: boolean) {
    setError(null);
    setBusy(run ? "run" : "fill");
    try {
      const res = await draft(idea.trim());
      onDone(res.brief, run && !blocked);
      setIdea("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const ready = idea.trim().length >= 3 && !busy;

  return (
    <div className="draft-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div ref={dialog} className="draft-dialog" role="dialog" aria-modal="true" aria-labelledby="draft-h" aria-describedby="draft-sub">
        <button type="button" className="draft-x" onClick={onClose} disabled={!!busy} aria-label="Close">
          ×
        </button>
        <div className="eyebrow">QUICK START</div>
        <h2 id="draft-h">What’s your idea?</h2>
        <p id="draft-sub" className="draft-sub">
          One or two sentences is enough. AI fills in the rest of the form for you, then the council votes on it.
        </p>
        <textarea
          ref={box}
          className="field draft-box"
          rows={4}
          maxLength={1000}
          value={idea}
          disabled={!!busy}
          onChange={(e) => setIdea(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && ready && go(true)}
          placeholder="e.g. An app that splits rent and bills between flatmates automatically"
          aria-label="Your idea"
        />
        {!idea && (
          <div className="draft-examples" aria-label="Examples">
            {EXAMPLES.map((x) => (
              <button key={x} type="button" className="draft-chip" onClick={() => setIdea(x)}>
                {x}
              </button>
            ))}
          </div>
        )}
        <p className="draft-source">This uses {source}.</p>
        {blocked && <p className="blocked-note">{blocked} You can still fill in the form.</p>}
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <div className="draft-actions">
          <button type="button" className="gbtn ghost" disabled={!ready} onClick={() => go(false)}>
            {busy === "fill" ? "Writing…" : "Just fill in the form"}
          </button>
          <button type="button" className="gbtn primary" disabled={!ready || !!blocked} onClick={() => go(true)}>
            {busy === "run" ? "Writing…" : "Fill it in and ask the council"}
          </button>
        </div>
        {busy && <p className="draft-wait" aria-live="polite">AI is filling in the form. This takes a few seconds.</p>}
        {onHideNextTime && (
          <label className="draft-hide">
            <input type="checkbox" checked={hide} onChange={(e) => (setHide(e.target.checked), onHideNextTime(e.target.checked))} />
            <span>Don’t open this by itself next time</span>
          </label>
        )}
      </div>
    </div>
  );
}
