export type TelemetryKind = "log" | "metric" | "trace";
export type Severity = "debug" | "info" | "warn" | "error" | "critical";
export type IncidentStatus = "replaying" | "investigating" | "resolved";
export type HypothesisState = "supported" | "low_confidence";

export interface ServiceDependency {
  source: string;
  target: string;
  relationship: string;
  risk: "normal" | "degraded" | "critical";
}

export interface Incident {
  id: string;
  scenario_id: string;
  title: string;
  status: IncidentStatus;
  started_at: string;
  updated_at: string;
  impacted_services: string[];
  customer_impact: string;
  service_map: ServiceDependency[];
}

export interface TelemetryEvent {
  id: string;
  incident_id: string;
  offset_ms: number;
  timestamp: string;
  kind: TelemetryKind;
  service: string;
  severity: Severity;
  name: string;
  message: string;
  attributes: Record<string, string | number | boolean | null>;
  trace_id?: string | null;
  span_id?: string | null;
}

export interface Evidence {
  id: string;
  event_id: string;
  source: TelemetryKind;
  service: string;
  quote: string;
  weight: number;
}

export interface Hypothesis {
  id: string;
  title: string;
  state: HypothesisState;
  confidence: number;
  summary: string;
  rationale: string;
  evidence: Evidence[];
  recommended_actions: string[];
}

export interface Postmortem {
  incident_id: string;
  title: string;
  generated_at: string;
  ai_provider: string;
  source_hypothesis_id: string;
  confidence: number;
  citation_coverage: number;
  executive_summary: string;
  root_cause: string;
  impact: string;
  timeline: string[];
  evidence: Evidence[];
  corrective_actions: string[];
  markdown: string;
}

export type StreamEnvelope =
  | { type: "telemetry_event"; incident_id: string; payload: TelemetryEvent }
  | { type: "finding"; incident_id: string; payload: Hypothesis }
  | { type: "status_update"; incident_id: string; payload: Incident };
