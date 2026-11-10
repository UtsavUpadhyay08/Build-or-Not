import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { SLIDER_FIELDS, type ApiMeta, type IdeaBrief, type IdeaSliders, type PanelMode } from "../types";

const DEFAULT_SLIDERS: IdeaSliders = { reach: 5, buildCost: 5, userImportance: 5, complexity: 5, value: 5, risk: 5 };

export function IdeaForm() {
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [targetAudience, setTargetAudience] = useState("");
  const [pricingModel, setPricingModel] = useState("");
  const [competitors, setCompetitors] = useState("");
  const [sliders, setSliders] = useState<IdeaSliders>(DEFAULT_SLIDERS);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<ApiMeta | null>(null);
  const [panelMode, setPanelMode] = useState<PanelMode>("single");

  useEffect(() => {
    api.getMeta().then((m) => {
      setMeta(m);
      setPanelMode(m.panelMode);
    }).catch(() => {});
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!title.trim() || !description.trim()) {
      setError("Title and description are required — the panel needs something real to react to.");
      return;
    }
    setSubmitting(true);
    const brief: IdeaBrief = { title: title.trim(), description: description.trim(), targetAudience, pricingModel, competitors, sliders };
    try {
      const { id } = await api.submitIdea({ ...brief, panelMode });
      navigate(`/ideas/${id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <form className="card idea-form" onSubmit={onSubmit}>
      <h2>Submit an idea</h2>
      <p className="muted">
        Describe a feature or product idea. 45 independent AI personas — end users, investors, critics, edge cases, and the people who'd
        have to build/support/sell it — will each give their own honest verdict.
      </p>

      <label className="field">
        <span>Title</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Dark mode for the invoicing app" maxLength={200} />
      </label>

      <label className="field">
        <span>Description</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What is it, what does it do, and what problem does it solve?"
          rows={4}
          maxLength={4000}
        />
      </label>

      <div className="field-row">
        <label className="field">
          <span>Target audience</span>
          <input value={targetAudience} onChange={(e) => setTargetAudience(e.target.value)} placeholder="Who is this for?" />
        </label>
        <label className="field">
          <span>Pricing / business model</span>
          <input value={pricingModel} onChange={(e) => setPricingModel(e.target.value)} placeholder="Free, subscription, one-time, etc." />
        </label>
      </div>

      <label className="field">
        <span>Known competitors / alternatives</span>
        <input value={competitors} onChange={(e) => setCompetitors(e.target.value)} placeholder="What do people use instead, today?" />
      </label>

      <h3>Rate the idea (1 = low, 10 = high)</h3>
      <div className="sliders">
        {SLIDER_FIELDS.map((f) => (
          <div className="slider-field" key={f.key}>
            <div className="slider-label-row">
              <span className="slider-label">{f.label}</span>
              <span className="slider-value">{sliders[f.key]}</span>
            </div>
            <input
              type="range"
              min={1}
              max={10}
              value={sliders[f.key]}
              onChange={(e) => setSliders((s) => ({ ...s, [f.key]: Number(e.target.value) }))}
            />
            <div className="slider-endpoints">
              <span>{f.low}</span>
              <span>{f.high}</span>
            </div>
          </div>
        ))}
      </div>

      {meta && !meta.mock && meta.health.some((h) => h.status === "ok") && (
        <div className="info-box">
          <strong>Panel models:</strong>{" "}
          {meta.health
            .filter((h) => h.status === "ok")
            .map((h) => `${h.name}/${h.model}`)
            .join(" · ")}
          {meta.health.filter((h) => h.note && h.status === "ok").map((h) => (
            <div key={h.name} className="muted-small">{h.note}</div>
          ))}
        </div>
      )}

      {meta && meta.health.some((h) => h.status !== "ok") && (
        <div className={meta.providers.some((p) => p.usable) ? "warn-box" : "error-box"}>
          <strong>{meta.providers.some((p) => p.usable) ? "Some AI providers are switched off:" : "No AI provider is working, so the panel can't run:"}</strong>
          <ul className="health-list">
            {meta.health
              .filter((h) => h.status !== "ok")
              .map((h) => (
                <li key={h.name + h.model}>
                  <code>{h.name}</code> (key {h.keyHint}): {h.message}
                </li>
              ))}
          </ul>
          After editing <code>.env</code>, restart the server (Ctrl+C, then <code>npm run dev</code>).
        </div>
      )}

      {meta && meta.providers.filter((p) => p.usable).length > 1 && (
        <fieldset className="panel-mode">
          <legend>Who sits on the panel?</legend>
          <label>
            <input type="radio" name="panelMode" checked={panelMode === "single"} onChange={() => setPanelMode("single")} />
            One model ({meta.providers.find((p) => p.usable)?.model}) for all 45 personas
          </label>
          <label>
            <input type="radio" name="panelMode" checked={panelMode === "mixed"} onChange={() => setPanelMode("mixed")} />
            Mixed: personas split across {meta.providers.filter((p) => p.usable).map((p) => p.model).join(", ")}, so one model's blind spots don't dominate
          </label>
        </fieldset>
      )}

      {error && <div className="error-box">{error}</div>}

      <button type="submit" disabled={submitting || (!!meta && !meta.mock && !meta.providers.some((p) => p.usable))} className="primary-button">
        {submitting ? "Convening the panel…" : "Submit to the panel of 45"}
      </button>
    </form>
  );
}
