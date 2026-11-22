// Cross-scenario comparison lab. All numbers come from the deterministic toy
// model in @/lib/brain-sim — illustrative teaching values, never patient data.
import { useMemo, useState } from "react";
import { ArrowLeftRight, GitCompareArrows } from "lucide-react";
import { SCENARIOS, agentSearch, makeBrainModel, score, type Scenario } from "@/lib/brain-sim";

const pct = (v: number) => `${Math.round(v * 100)}%`;

function scenarioStats(s: Scenario) {
  const regions = makeBrainModel(s);
  const search = agentSearch(regions, s);
  const bestScore = score(regions, s, search.best.dose);
  const meanSignal = regions.reduce((sum, r) => sum + r.signal, 0) / regions.length;
  const hottest = regions.reduce((a, b) => (b.signal > a.signal ? b : a));
  return { regions, search, bestScore, meanSignal, hottest };
}

function ScenarioColumn({ scenario }: { scenario: Scenario }) {
  const stats = useMemo(() => scenarioStats(scenario), [scenario]);
  const maxSignal = Math.max(...stats.regions.map((r) => r.signal), 0.01);
  return (
    <div className="compare-column">
      <p className="compare-scenario-name">{scenario.name}</p>
      <dl className="signal-metrics">
        <div><dt>Mean signal</dt><dd className="text-affected">{pct(stats.meanSignal)}</dd></div>
        <div><dt>Strongest region</dt><dd>{stats.hottest.shortName}</dd></div>
        <div><dt>Best toy dose</dt><dd>{stats.search.best.dose.toFixed(1)}</dd></div>
      </dl>
      <div className="compare-bars" aria-label={`Regional signals for ${scenario.name}`}>
        {stats.regions.map((r) => (
          <div key={r.id} className="compare-bar-row">
            <span className="compare-bar-label">{r.shortName}</span>
            <div className="compare-bar"><i style={{ width: `${Math.max(3, (r.signal / maxSignal) * 100)}%` }} /></div>
            <span className="compare-bar-value">{pct(r.signal)}</span>
          </div>
        ))}
      </div>
      <p className="signal-lab-note">At the agent's best dose, the toy model responds <strong>{pct(stats.bestScore.response)}</strong> of total signal with <strong>{pct(stats.bestScore.impact)}</strong> network impact.</p>
    </div>
  );
}

export function CompareLab() {
  const [leftId, setLeftId] = useState(SCENARIOS[0]?.id ?? "amyloid");
  const [rightId, setRightId] = useState(SCENARIOS[1]?.id ?? "tau");
  const left = SCENARIOS.find((s) => s.id === leftId) ?? SCENARIOS[0];
  const right = SCENARIOS.find((s) => s.id === rightId) ?? SCENARIOS[1];
  if (!left || !right) return null;

  function swap() { setLeftId(rightId); setRightId(leftId); }

  return (
    <section className="compare-lab" aria-label="Scenario comparison lab">
      <div className="section-heading">
        <div><p className="eyebrow">03 / COMPARE LAB</p><h2>Put two mechanisms<br />side by side.</h2></div>
        <p>Pick any two scenarios and compare their hand-set regional signals, strongest regions and agent dose rankings. Same deterministic toy model on both sides — a teaching comparison, not a clinical one.</p>
      </div>
      <div className="compare-picker">
        <label className="compare-select">
          <span className="eyebrow">LEFT</span>
          <select value={left.id} onChange={(e) => setLeftId(e.target.value)} aria-label="Left scenario">
            {SCENARIOS.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <button type="button" className="compare-swap" onClick={swap} aria-label="Swap scenarios"><ArrowLeftRight /></button>
        <label className="compare-select">
          <span className="eyebrow">RIGHT</span>
          <select value={right.id} onChange={(e) => setRightId(e.target.value)} aria-label="Right scenario">
            {SCENARIOS.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
      </div>
      <div className="compare-grid">
        <ScenarioColumn scenario={left} />
        <div className="compare-divider" aria-hidden="true"><GitCompareArrows /></div>
        <ScenarioColumn scenario={right} />
      </div>
    </section>
  );
}
