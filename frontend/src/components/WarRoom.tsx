"use client";

import {
  Activity,
  AlertTriangle,
  Brain,
  CheckCircle2,
  Clipboard,
  Clock3,
  Download,
  FileText,
  Filter,
  GitBranch,
  Gauge,
  Play,
  RefreshCcw,
  Search,
  Server,
  ShieldCheck,
  Wifi,
  WifiOff
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { analyzeIncident, getHypotheses, getPostmortem, getTimeline, listIncidents, openIncidentStream, startReplay } from "@/lib/api";
import type { Evidence, Hypothesis, Incident, Postmortem, Severity, StreamEnvelope, TelemetryEvent } from "@/lib/types";

type Tab = "warroom" | "evidence" | "services" | "postmortem";
type StreamState = "open" | "closed" | "error";
type ServiceHealth = { service: string; risk: string; worst: Severity; latency?: TelemetryEvent };
type IncidentStats = {
  progress: number;
  latestSecond: number;
  severityLabel: string;
  severityTone: "normal" | "degraded" | "critical";
  criticalEvents: number;
  warnEvents: number;
  citedEvents: number;
  peakPaymentLatency: number;
  currentSuccessRate: number | null;
  retryDepth: number;
};

const tabs: Array<{ id: Tab; label: string; icon: LucideIcon }> = [
  { id: "warroom", label: "War Room", icon: Activity },
  { id: "evidence", label: "Evidence", icon: Search },
  { id: "services", label: "Services", icon: GitBranch },
  { id: "postmortem", label: "Postmortem", icon: FileText }
];

const severityRank: Record<Severity, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  critical: 4
};

export function WarRoom() {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [activeIncident, setActiveIncident] = useState<Incident | null>(null);
  const [timeline, setTimeline] = useState<TelemetryEvent[]>([]);
  const [hypotheses, setHypotheses] = useState<Hypothesis[]>([]);
  const [postmortem, setPostmortem] = useState<Postmortem | null>(null);
  const [tab, setTab] = useState<Tab>("warroom");
  const [streamState, setStreamState] = useState<StreamState>("closed");
  const [isStarting, setIsStarting] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isWriting, setIsWriting] = useState(false);
  const [serviceFilter, setServiceFilter] = useState("all");
  const [kindFilter, setKindFilter] = useState("all");
  const [error, setError] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    void refreshIncidents();
    return () => socketRef.current?.close();
  }, []);

  const services = useMemo(() => {
    const names = new Set<string>(activeIncident?.impacted_services || []);
    timeline.forEach((event) => names.add(event.service));
    return Array.from(names).sort();
  }, [activeIncident, timeline]);

  const topHypothesis = hypotheses[0];
  const evidenceByEventId = useMemo(() => {
    const map = new Map<string, Evidence>();
    hypotheses.flatMap((hypothesis) => hypothesis.evidence).forEach((item) => map.set(item.event_id, item));
    return map;
  }, [hypotheses]);

  const filteredTimeline = useMemo(() => {
    return timeline.filter((event) => {
      const serviceMatches = serviceFilter === "all" || event.service === serviceFilter;
      const kindMatches = kindFilter === "all" || event.kind === kindFilter;
      return serviceMatches && kindMatches;
    });
  }, [kindFilter, serviceFilter, timeline]);

  const serviceHealth = useMemo(() => {
    return services.map((service) => {
      const events = timeline.filter((event) => event.service === service);
      const worst = events.reduce<Severity>((current, event) => {
        return severityRank[event.severity] > severityRank[current] ? event.severity : current;
      }, "info");
      const latency = [...events].reverse().find((event) => event.name.includes("latency"));
      const risk = worst === "critical" || worst === "error" ? "critical" : worst === "warn" ? "degraded" : "normal";
      return { service, risk, worst, latency };
    });
  }, [services, timeline]);

  const incidentStats = useMemo<IncidentStats>(() => {
    const latestOffset = timeline.at(-1)?.offset_ms || 0;
    const criticalEvents = timeline.filter((event) => ["critical", "error"].includes(event.severity)).length;
    const warnEvents = timeline.filter((event) => event.severity === "warn").length;
    const peakPaymentLatency = Math.max(
      0,
      ...timeline
        .filter((event) => event.service === "payment-service" && event.name.includes("latency"))
        .map((event) => numberAttribute(event, "value"))
    );
    const currentSuccessRate =
      [...timeline].reverse().find((event) => event.name === "checkout.success_rate")?.attributes.value ?? null;
    const retryDepth = Math.max(
      0,
      ...timeline.filter((event) => event.name === "retry.queue_depth").map((event) => numberAttribute(event, "value"))
    );
    const severityTone = criticalEvents ? "critical" : warnEvents ? "degraded" : "normal";
    const severityLabel = criticalEvents ? "SEV-2 active" : warnEvents ? "degraded" : "nominal";
    return {
      progress: Math.min(100, Math.round((latestOffset / 15000) * 100)),
      latestSecond: Math.round(latestOffset / 1000),
      severityLabel,
      severityTone,
      criticalEvents,
      warnEvents,
      citedEvents: evidenceByEventId.size,
      peakPaymentLatency,
      currentSuccessRate: typeof currentSuccessRate === "number" ? currentSuccessRate : null,
      retryDepth
    };
  }, [evidenceByEventId.size, timeline]);

  async function refreshIncidents() {
    try {
      const data = await listIncidents();
      setIncidents(data);
      if (!activeIncident && data.length) {
        await selectIncident(data[0]);
      }
    } catch {
      setError("API offline. Start the FastAPI server on port 8000.");
    }
  }

  async function selectIncident(incident: Incident) {
    setActiveIncident(incident);
    setPostmortem(null);
    setHypotheses([]);
    setTimeline([]);
    setError(null);
    socketRef.current?.close();
    try {
      const [existing, savedHypotheses] = await Promise.all([getTimeline(incident.id), getHypotheses(incident.id)]);
      setTimeline(sortEvents(existing));
      setHypotheses(sortHypotheses(savedHypotheses));
    } catch {
      setError("Unable to load incident timeline.");
    }
    connectStream(incident.id);
  }

  async function handleStartReplay() {
    setIsStarting(true);
    setError(null);
    setPostmortem(null);
    setHypotheses([]);
    setTimeline([]);
    socketRef.current?.close();
    try {
      const incident = await startReplay(0.18);
      setActiveIncident(incident);
      setIncidents((current) => [incident, ...current.filter((item) => item.id !== incident.id)]);
      connectStream(incident.id);
      setTab("warroom");
    } catch {
      setError("Unable to start replay. Check the backend server.");
    } finally {
      setIsStarting(false);
    }
  }

  async function handleAnalyze() {
    if (!activeIncident) return;
    setIsAnalyzing(true);
    setError(null);
    try {
      const findings = await analyzeIncident(activeIncident.id);
      setHypotheses(sortHypotheses(findings));
    } catch {
      setError("Analysis request failed.");
    } finally {
      setIsAnalyzing(false);
    }
  }

  async function handleGeneratePostmortem() {
    if (!activeIncident) return;
    setIsWriting(true);
    setError(null);
    try {
      const report = await getPostmortem(activeIncident.id);
      setPostmortem(report);
      setTab("postmortem");
    } catch {
      setError("Postmortem generation failed.");
    } finally {
      setIsWriting(false);
    }
  }

  function connectStream(incidentId: string) {
    socketRef.current?.close();
    const socket = openIncidentStream(
      incidentId,
      (event) => applyStreamEvent(event),
      (state) => setStreamState(state)
    );
    socketRef.current = socket;
  }

  function applyStreamEvent(event: StreamEnvelope) {
    if (event.type === "status_update") {
      setActiveIncident(event.payload);
      setIncidents((current) => [event.payload, ...current.filter((item) => item.id !== event.payload.id)]);
      return;
    }
    if (event.type === "telemetry_event") {
      setTimeline((current) => sortEvents(upsertById(current, event.payload)));
      return;
    }
    if (event.type === "finding") {
      setHypotheses((current) => sortHypotheses(upsertById(current, event.payload)));
    }
  }

  function downloadPostmortem() {
    if (!postmortem) return;
    const blob = new Blob([postmortem.markdown], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "pulselens-postmortem.md";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function copyPostmortem() {
    if (!postmortem) return;
    await navigator.clipboard.writeText(postmortem.markdown);
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark">
            <Activity size={20} aria-hidden="true" />
          </div>
          <div>
            <p className="eyebrow">PulseLens</p>
            <h1>AI Incident War Room</h1>
          </div>
        </div>
        <div className="topbar-actions">
          <span className={`connection-pill ${streamState}`}>
            {streamState === "open" ? <Wifi size={16} /> : <WifiOff size={16} />}
            {streamState === "open" ? "Live stream" : streamState === "error" ? "Stream error" : "Offline"}
          </span>
          <button className="button secondary" onClick={refreshIncidents} title="Refresh incidents">
            <RefreshCcw size={16} />
            Refresh
          </button>
          <button className="button primary" onClick={handleStartReplay} disabled={isStarting} title="Start replay">
            <Play size={16} />
            {isStarting ? "Starting" : "Start replay"}
          </button>
        </div>
      </header>

      {error ? (
        <div className="alert-row" role="alert">
          <AlertTriangle size={18} />
          {error}
        </div>
      ) : null}

      <main className="workspace">
        <aside className="incident-rail">
          <div className="rail-header">
            <span>Incidents</span>
            <strong>{incidents.length}</strong>
          </div>
          <div className="incident-list">
            {incidents.length ? (
              incidents.map((incident) => (
                <button
                  key={incident.id}
                  className={`incident-row ${activeIncident?.id === incident.id ? "selected" : ""}`}
                  onClick={() => void selectIncident(incident)}
                >
                  <span className={`status-dot ${incident.status}`} />
                  <span>
                    <strong>{incident.title}</strong>
                    <small>{incident.customer_impact}</small>
                  </span>
                </button>
              ))
            ) : (
              <div className="empty-state">No incident replay yet.</div>
            )}
          </div>
        </aside>

        <section className="work-area">
          <div className="incident-heading">
            <div>
              <p className="eyebrow">{activeIncident?.scenario_id || "checkout-timeout"}</p>
              <h2>{activeIncident?.title || "Checkout timeout spike"}</h2>
              <p>{activeIncident?.customer_impact || "Start a replay to stream the incident timeline."}</p>
            </div>
            <div className="analysis-actions">
              <button className="button secondary" onClick={handleAnalyze} disabled={!activeIncident || isAnalyzing} title="Run analysis">
                <Brain size={16} />
                {isAnalyzing ? "Analyzing" : "Analyze"}
              </button>
              <button className="button secondary" onClick={handleGeneratePostmortem} disabled={!activeIncident || isWriting} title="Generate postmortem">
                <FileText size={16} />
                {isWriting ? "Writing" : "Generate"}
              </button>
            </div>
          </div>

          <IncidentBanner
            activeIncident={activeIncident}
            stats={incidentStats}
            topHypothesis={topHypothesis}
            streamState={streamState}
          />

          <nav className="tabs" aria-label="Incident views">
            {tabs.map((item) => {
              const Icon = item.icon;
              return (
                <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}>
                  <Icon size={16} />
                  {item.label}
                </button>
              );
            })}
          </nav>

          {tab === "warroom" ? (
            <WarRoomView
              activeIncident={activeIncident}
              timeline={timeline}
              hypotheses={hypotheses}
              serviceHealth={serviceHealth}
              topHypothesis={topHypothesis}
              stats={incidentStats}
            />
          ) : null}

          {tab === "evidence" ? (
            <EvidenceView
              timeline={filteredTimeline}
              allServices={services}
              serviceFilter={serviceFilter}
              kindFilter={kindFilter}
              evidenceByEventId={evidenceByEventId}
              onServiceFilter={setServiceFilter}
              onKindFilter={setKindFilter}
            />
          ) : null}

          {tab === "services" ? (
            <ServicesView incident={activeIncident} serviceHealth={serviceHealth} timeline={timeline} stats={incidentStats} />
          ) : null}

          {tab === "postmortem" ? (
            <PostmortemView
              postmortem={postmortem}
              onGenerate={handleGeneratePostmortem}
              onCopy={copyPostmortem}
              onDownload={downloadPostmortem}
              disabled={!activeIncident || isWriting}
            />
          ) : null}
        </section>
      </main>
    </div>
  );
}

function WarRoomView({
  activeIncident,
  timeline,
  hypotheses,
  serviceHealth,
  topHypothesis,
  stats
}: {
  activeIncident: Incident | null;
  timeline: TelemetryEvent[];
  hypotheses: Hypothesis[];
  serviceHealth: ServiceHealth[];
  topHypothesis?: Hypothesis;
  stats: IncidentStats;
}) {
  const errorEvents = timeline.filter((event) => ["error", "critical"].includes(event.severity)).length;
  const latestEvent = timeline[timeline.length - 1];
  const paymentLatency = timeline.filter((event) => event.service === "payment-service" && event.name.includes("latency"));
  const checkoutRates = timeline.filter((event) => event.name === "checkout.success_rate" || event.name === "checkout.error_rate");

  return (
    <div className="view-grid warroom-grid">
      <section className="metric-strip">
        <MetricTile icon={Clock3} label="Events" value={timeline.length.toString()} detail={latestEvent ? `+${Math.round(latestEvent.offset_ms / 1000)}s latest` : "waiting"} />
        <MetricTile icon={Gauge} label="Errors" value={errorEvents.toString()} detail="critical path" tone={errorEvents ? "danger" : "good"} />
        <MetricTile icon={Server} label="Services" value={serviceHealth.length.toString()} detail={activeIncident?.status || "idle"} />
        <MetricTile icon={ShieldCheck} label="Confidence" value={topHypothesis ? `${Math.round(topHypothesis.confidence * 100)}%` : "0%"} detail={topHypothesis?.state || "pending"} tone={topHypothesis?.state === "supported" ? "good" : "warn"} />
      </section>

      <section className="panel chart-panel">
        <div className="panel-title">
          <div>
            <p className="eyebrow">Replay Progress</p>
            <h3>Signal evolution</h3>
          </div>
          <span className={`severity-chip ${stats.severityTone}`}>{stats.severityLabel}</span>
        </div>
        <ReplayProgress progress={stats.progress} latestSecond={stats.latestSecond} />
        <div className="signal-charts">
          <SignalChart
            title="Payment p95 latency"
            unit="ms"
            tone="danger"
            events={paymentLatency}
            max={5000}
          />
          <SignalChart
            title="Checkout health"
            unit="%"
            tone="warn"
            events={checkoutRates}
            max={100}
          />
        </div>
      </section>

      <section className="panel blast-panel">
        <div className="panel-title">
          <div>
            <p className="eyebrow">Blast Radius</p>
            <h3>Services at risk</h3>
          </div>
        </div>
        <BlastRadius serviceHealth={serviceHealth} />
      </section>

      <section className="panel timeline-panel">
        <div className="panel-title">
          <div>
            <p className="eyebrow">Live Timeline</p>
            <h3>Correlated telemetry</h3>
          </div>
        </div>
        <div className="timeline">
          {timeline.length ? timeline.map((event) => <TimelineItem key={event.id} event={event} />) : <div className="empty-state">Start a replay to stream telemetry.</div>}
        </div>
      </section>

      <section className="panel hypothesis-panel">
        <div className="panel-title">
          <div>
            <p className="eyebrow">Hypotheses</p>
            <h3>Root-cause ranking</h3>
          </div>
        </div>
        <div className="hypothesis-stack">
          {hypotheses.length ? hypotheses.map((hypothesis) => <HypothesisCard key={hypothesis.id} hypothesis={hypothesis} />) : <div className="empty-state">Analysis will appear as findings arrive.</div>}
        </div>
      </section>
    </div>
  );
}

function EvidenceView({
  timeline,
  allServices,
  serviceFilter,
  kindFilter,
  evidenceByEventId,
  onServiceFilter,
  onKindFilter
}: {
  timeline: TelemetryEvent[];
  allServices: string[];
  serviceFilter: string;
  kindFilter: string;
  evidenceByEventId: Map<string, Evidence>;
  onServiceFilter: (value: string) => void;
  onKindFilter: (value: string) => void;
}) {
  return (
    <section className="panel full-panel">
      <div className="panel-title">
        <div>
          <p className="eyebrow">Evidence Explorer</p>
          <h3>Cited logs, metrics, and traces</h3>
        </div>
        <div className="filters">
          <label>
            <Filter size={15} />
            <select value={serviceFilter} onChange={(event) => onServiceFilter(event.target.value)}>
              <option value="all">All services</option>
              {allServices.map((service) => (
                <option key={service} value={service}>
                  {service}
                </option>
              ))}
            </select>
          </label>
          <label>
            <Search size={15} />
            <select value={kindFilter} onChange={(event) => onKindFilter(event.target.value)}>
              <option value="all">All signals</option>
              <option value="metric">Metrics</option>
              <option value="trace">Traces</option>
              <option value="log">Logs</option>
            </select>
          </label>
        </div>
      </div>
      <div className="evidence-table">
        {timeline.length ? (
          timeline.map((event) => {
            const evidence = evidenceByEventId.get(event.id);
            return (
              <article key={event.id} className={`evidence-row ${event.severity}`}>
                <div>
                  <span className="mono">+{Math.round(event.offset_ms / 1000)}s</span>
                  <strong>{event.name}</strong>
                  <p>{event.message}</p>
                  <AttributeList event={event} />
                </div>
                <div className="event-meta">
                  <span>{event.service}</span>
                  <span>{event.kind}</span>
                  <span>{event.severity}</span>
                  {evidence ? <mark>{evidence.id}</mark> : null}
                </div>
              </article>
            );
          })
        ) : (
          <div className="empty-state">No matching telemetry.</div>
        )}
      </div>
    </section>
  );
}

function ServicesView({
  incident,
  serviceHealth,
  timeline,
  stats
}: {
  incident: Incident | null;
  serviceHealth: ServiceHealth[];
  timeline: TelemetryEvent[];
  stats: IncidentStats;
}) {
  const dependencyEvents = new Map(timeline.map((event) => [event.service, event]));
  return (
    <div className="view-grid service-grid">
      <section className="panel full-panel">
        <div className="panel-title">
          <div>
            <p className="eyebrow">Operational Summary</p>
            <h3>Current incident posture</h3>
          </div>
        </div>
        <div className="ops-summary">
          <SummaryCell label="Peak payment latency" value={stats.peakPaymentLatency ? `${stats.peakPaymentLatency} ms` : "waiting"} />
          <SummaryCell label="Latest checkout success" value={stats.currentSuccessRate ? `${stats.currentSuccessRate}%` : "waiting"} />
          <SummaryCell label="Retry queue depth" value={stats.retryDepth ? `${stats.retryDepth} jobs` : "waiting"} />
          <SummaryCell label="Cited evidence" value={`${stats.citedEvents} events`} />
        </div>
      </section>

      <section className="panel full-panel">
        <div className="panel-title">
          <div>
            <p className="eyebrow">Service Map</p>
            <h3>Checkout dependency path</h3>
          </div>
        </div>
        <div className="service-map">
          {(incident?.service_map || []).map((edge) => (
            <article key={`${edge.source}-${edge.target}`} className={`service-edge ${edge.risk}`}>
              <div className="service-node">
                <Server size={16} />
                {edge.source}
              </div>
              <div className="edge-line">{edge.relationship}</div>
              <div className="service-node target">
                <Server size={16} />
                {edge.target}
              </div>
            </article>
          ))}
          {!incident ? <div className="empty-state">No active incident.</div> : null}
        </div>
      </section>

      <section className="panel full-panel">
        <div className="panel-title">
          <div>
            <p className="eyebrow">Health</p>
            <h3>Service signal summary</h3>
          </div>
        </div>
        <div className="health-grid">
          {serviceHealth.map((item) => {
            const latest = dependencyEvents.get(item.service);
            return (
              <article key={item.service} className={`health-card ${item.risk}`}>
                <div>
                  <strong>{item.service}</strong>
                  <span>{item.risk}</span>
                </div>
                <p>{latest?.message || "No recent signal."}</p>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function PostmortemView({
  postmortem,
  onGenerate,
  onCopy,
  onDownload,
  disabled
}: {
  postmortem: Postmortem | null;
  onGenerate: () => void;
  onCopy: () => void;
  onDownload: () => void;
  disabled: boolean;
}) {
  return (
    <section className="panel full-panel postmortem-panel">
      <div className="panel-title">
        <div>
          <p className="eyebrow">Postmortem</p>
          <h3>Evidence-cited report</h3>
        </div>
        <div className="analysis-actions">
          <button className="button secondary" onClick={onGenerate} disabled={disabled} title="Generate report">
            <FileText size={16} />
            Generate
          </button>
          <button className="button secondary" onClick={onCopy} disabled={!postmortem} title="Copy Markdown">
            <Clipboard size={16} />
            Copy
          </button>
          <button className="button secondary" onClick={onDownload} disabled={!postmortem} title="Download Markdown">
            <Download size={16} />
            Export
          </button>
        </div>
      </div>
      {postmortem ? (
        <article className="report-preview">
          <div className="report-meta">
            <span>Provider: {postmortem.ai_provider}</span>
            <span>Confidence: {Math.round(postmortem.confidence * 100)}%</span>
            <span>Citation coverage: {Math.round(postmortem.citation_coverage * 100)}%</span>
          </div>
          <pre>{postmortem.markdown}</pre>
        </article>
      ) : (
        <div className="empty-state">Generate a report after the replay has produced evidence.</div>
      )}
    </section>
  );
}

function MetricTile({
  icon: Icon,
  label,
  value,
  detail,
  tone = "neutral"
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  detail: string;
  tone?: "neutral" | "good" | "warn" | "danger";
}) {
  return (
    <article className={`metric-tile ${tone}`}>
      <Icon size={18} />
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

function TimelineItem({ event }: { event: TelemetryEvent }) {
  return (
    <article className={`timeline-item ${event.severity}`}>
      <div className="timeline-time">+{Math.round(event.offset_ms / 1000)}s</div>
      <div className="timeline-copy">
        <div>
          <strong>{event.name}</strong>
          <span>{event.service}</span>
        </div>
        <p>{event.message}</p>
      </div>
      <span className="signal-kind">{event.kind}</span>
    </article>
  );
}

function HypothesisCard({ hypothesis }: { hypothesis: Hypothesis }) {
  return (
    <article className={`hypothesis-card ${hypothesis.state}`}>
      <div className="hypothesis-head">
        <div>
          <span className="state-pill">{hypothesis.state === "supported" ? "Supported" : "Low confidence"}</span>
          <h4>{hypothesis.title}</h4>
        </div>
        <strong>{Math.round(hypothesis.confidence * 100)}%</strong>
      </div>
      <div className="confidence-meter" aria-label={`Confidence ${Math.round(hypothesis.confidence * 100)} percent`}>
        <span style={{ width: `${Math.round(hypothesis.confidence * 100)}%` }} />
      </div>
      <p>{hypothesis.summary}</p>
      <div className="citation-row">
        {hypothesis.evidence.map((item) => (
          <mark key={item.id}>{item.id}</mark>
        ))}
      </div>
      <ul>
        {hypothesis.recommended_actions.slice(0, 2).map((action) => (
          <li key={action}>
            <CheckCircle2 size={15} />
            {action}
          </li>
        ))}
      </ul>
    </article>
  );
}

function IncidentBanner({
  activeIncident,
  stats,
  topHypothesis,
  streamState
}: {
  activeIncident: Incident | null;
  stats: IncidentStats;
  topHypothesis?: Hypothesis;
  streamState: StreamState;
}) {
  const headline = topHypothesis?.title || "Waiting for correlated telemetry";
  return (
    <section className={`incident-banner ${stats.severityTone}`}>
      <div>
        <span className="banner-kicker">{activeIncident?.status || "ready"} · {streamState === "open" ? "stream connected" : "stream offline"}</span>
        <strong>{headline}</strong>
        <p>
          {topHypothesis
            ? `${Math.round(topHypothesis.confidence * 100)}% confidence across ${stats.citedEvents} cited events.`
            : "Start a replay to watch telemetry move from raw signals into an evidence-backed root-cause hypothesis."}
        </p>
      </div>
      <div className="banner-metrics">
        <span>{stats.criticalEvents} critical/error</span>
        <span>{stats.warnEvents} warnings</span>
        <span>{stats.progress}% replayed</span>
      </div>
    </section>
  );
}

function ReplayProgress({ progress, latestSecond }: { progress: number; latestSecond: number }) {
  return (
    <div className="replay-progress">
      <div className="progress-copy">
        <span>+{latestSecond}s observed</span>
        <strong>{progress}%</strong>
      </div>
      <div className="progress-track">
        <span style={{ width: `${progress}%` }} />
      </div>
    </div>
  );
}

function SignalChart({
  title,
  unit,
  tone,
  events,
  max
}: {
  title: string;
  unit: string;
  tone: "warn" | "danger";
  events: TelemetryEvent[];
  max: number;
}) {
  const latest = events.at(-1);
  return (
    <article className={`signal-chart ${tone}`}>
      <div>
        <span>{title}</span>
        <strong>{latest ? `${numberAttribute(latest, "value")}${unit}` : "waiting"}</strong>
      </div>
      <div className="bars" aria-hidden="true">
        {events.length ? (
          events.map((event) => {
            const value = numberAttribute(event, "value");
            return <i key={event.id} style={{ height: `${Math.max(8, Math.min(100, (value / max) * 100))}%` }} />;
          })
        ) : (
          Array.from({ length: 6 }).map((_, index) => <i key={index} className="ghost" />)
        )}
      </div>
    </article>
  );
}

function BlastRadius({ serviceHealth }: { serviceHealth: ServiceHealth[] }) {
  return (
    <div className="blast-grid">
      {serviceHealth.length ? (
        serviceHealth.map((item) => (
          <div key={item.service} className={`blast-node ${item.risk}`}>
            <strong>{item.service}</strong>
            <span>{item.worst}</span>
          </div>
        ))
      ) : (
        <div className="empty-state">No services observed yet.</div>
      )}
    </div>
  );
}

function AttributeList({ event }: { event: TelemetryEvent }) {
  const entries = Object.entries(event.attributes).slice(0, 4);
  if (!entries.length) return null;
  return (
    <div className="attribute-list">
      {entries.map(([key, value]) => (
        <span key={key}>
          {key}: {String(value)}
        </span>
      ))}
    </div>
  );
}

function SummaryCell({ label, value }: { label: string; value: string }) {
  return (
    <article className="summary-cell">
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function numberAttribute(event: TelemetryEvent, key: string) {
  const value = event.attributes[key];
  return typeof value === "number" ? value : 0;
}

function sortEvents(events: TelemetryEvent[]) {
  return [...events].sort((a, b) => a.offset_ms - b.offset_ms);
}

function sortHypotheses(hypotheses: Hypothesis[]) {
  return [...hypotheses].sort((a, b) => b.confidence - a.confidence);
}

function upsertById<T extends { id: string }>(items: T[], item: T) {
  return [item, ...items.filter((current) => current.id !== item.id)];
}
