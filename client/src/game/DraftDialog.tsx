import { useEffect, useRef, useState } from "react";
import type { IdeaBrief } from "../types";
import { PRODUCT_CONTEXT_MAX, PRODUCT_CONTEXT_MIN as PRODUCT_MIN } from "../types";
import { KindPick, PrivacyToggle, ProductBox, loadSavedProduct } from "./ProposalForm";

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
  /** Feature mode: the product's name — the AI drafts the feature against its description. */
  featureOf?: string | null;
  /** The startup/feature choice, product description and privacy, shared with the form. */
  settings: Pick<IdeaBrief, "kind" | "productContext" | "hidden">;
  onSettings: (patch: Partial<Pick<IdeaBrief, "kind" | "productContext" | "hidden">>) => void;
}

const EXAMPLES = ["An app that splits rent and bills between flatmates automatically", "A Chrome extension that summarises long Slack threads", "Weekend cooking classes taught by home cooks"];

/** The "just tell me your idea" popup: one box, then the AI fills in everything else. */
export function DraftDialog({ open, onClose, draft, onDone, source, blocked, hideNextTime, onHideNextTime, featureOf, settings, onSettings }: Props) {
  const feature = settings.kind === "feature";
  const product = settings.productContext ?? "";
  const productLen = product.trim().length;
  const productOver = product.length > PRODUCT_CONTEXT_MAX;
  /** A council run on a feature needs the product (every persona reads it). Filling in the form doesn't. */
  const productReady = !feature || (productLen >= PRODUCT_MIN && !productOver);
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

  // Focus the idea box once, when the popup opens. (This used to run on every re-render, so typing
  // in the product description pulled the cursor back to the idea box after each letter.)
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => box.current?.focus(), 30);
    return () => clearTimeout(t);
  }, [open]);

  const busyRef = useRef(busy);
  busyRef.current = busy;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // The sign-in dialog can open on top of this one: its keys (Escape, Tab) are its own.
      if (document.querySelector(".signin")) return;
      if (e.key === "Escape" && !busyRef.current) closeRef.current();
      if (e.key === "Tab" && dialog.current) {
        // Keep keyboard focus inside the popup.
        const f = [...dialog.current.querySelectorAll<HTMLElement>("button, textarea, input, [href]")].filter((el) => !el.hasAttribute("disabled"));
        if (!f.length) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last.focus());
        else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus());
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

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

  const ideaReady = idea.trim().length >= 3;
  const canFill = ideaReady && !busy && !productOver;
  const canRun = canFill && productReady && !blocked;
  // Say what's missing, instead of greyed-out buttons with no reason.
  const missing = busy
    ? null
    : !ideaReady
      ? feature
        ? "Write the feature idea in the box above (a sentence is enough)."
        : "Write your idea in the box above (a sentence is enough)."
      : productOver
        ? `Shorten the product description to ${PRODUCT_CONTEXT_MAX.toLocaleString("en")} characters first.`
        : !productReady
          ? productLen === 0
            ? "To ask the council about a feature, add your product’s description above (upload its description.md or paste a few lines). You can fill in the form without it."
            : `Add a few more words about your product (at least ${PRODUCT_MIN} characters, e.g. “Splitly, a rent-splitting app for flatmates”). You can fill in the form already.`
          : null;

  return (
    <div className="draft-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div ref={dialog} className="draft-dialog" role="dialog" aria-modal="true" aria-labelledby="draft-h" aria-describedby="draft-sub">
        <button type="button" className="draft-x" onClick={onClose} disabled={!!busy} aria-label="Close">
          ×
        </button>
        <div className="eyebrow">QUICK START</div>
        <h2 id="draft-h">{feature ? "What’s the feature?" : "What’s your idea?"}</h2>
        <p id="draft-sub" className="draft-sub">
          One or two sentences is enough. AI fills in the rest of the form for you, then the council votes on it.
        </p>
        <KindPick feature={feature} locked={!!busy} onStartup={() => onSettings({ kind: "startup" })} onFeature={() => onSettings({ kind: "feature", productContext: product || loadSavedProduct() })} />
        {feature && <ProductBox value={product} locked={!!busy} onChange={(v) => onSettings({ productContext: v })} />}
        {featureOf && <p className="draft-feature-note">Drafting a new feature for <strong>{featureOf}</strong>. The AI reads your product description too.</p>}
        <textarea
          ref={box}
          className="field draft-box"
          rows={4}
          maxLength={1000}
          value={idea}
          disabled={!!busy}
          onChange={(e) => setIdea(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && (canRun ? go(true) : canFill && go(false))}
          placeholder={feature ? "e.g. Settle up automatically when a flatmate moves out" : "e.g. An app that splits rent and bills between flatmates automatically"}
          aria-label="Your idea"
        />
        {!idea && !feature && (
          <div className="draft-examples" aria-label="Examples">
            {EXAMPLES.map((x) => (
              <button key={x} type="button" className="draft-chip" onClick={() => setIdea(x)}>
                {x}
              </button>
            ))}
          </div>
        )}
        <PrivacyToggle hidden={!!settings.hidden} locked={!!busy} onChange={(h) => onSettings({ hidden: h })} />
        <p className="draft-source">This uses {source}.</p>
        {blocked && <p className="blocked-note">{blocked} You can still fill in the form.</p>}
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <div className="draft-actions">
          <button type="button" className="gbtn ghost" disabled={!canFill} onClick={() => go(false)}>
            {busy === "fill" ? "Writing…" : "Just fill in the form"}
          </button>
          <button type="button" className="gbtn primary" disabled={!canRun} onClick={() => go(true)}>
            {busy === "run" ? "Writing…" : "Fill it in and ask the council"}
          </button>
        </div>
        {missing && (
          <p className="draft-missing" aria-live="polite">
            {missing}
          </p>
        )}
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
