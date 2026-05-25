from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel, Field


TelemetryKind = Literal["log", "metric", "trace"]
Severity = Literal["debug", "info", "warn", "error", "critical"]
IncidentStatus = Literal["replaying", "investigating", "resolved"]
HypothesisState = Literal["supported", "low_confidence"]
StreamEventType = Literal["telemetry_event", "finding", "status_update"]


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid4().hex[:10]}"


class ServiceDependency(BaseModel):
    source: str
    target: str
    relationship: str
    risk: Literal["normal", "degraded", "critical"] = "normal"


class Incident(BaseModel):
    id: str = Field(default_factory=lambda: new_id("inc"))
    scenario_id: str
    title: str
    status: IncidentStatus = "replaying"
    started_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)
    impacted_services: list[str] = Field(default_factory=list)
    customer_impact: str
    service_map: list[ServiceDependency] = Field(default_factory=list)


class TelemetryEvent(BaseModel):
    id: str
    incident_id: str
    offset_ms: int
    timestamp: datetime
    kind: TelemetryKind
    service: str
    severity: Severity = "info"
    name: str
    message: str
    attributes: dict[str, Any] = Field(default_factory=dict)
    trace_id: str | None = None
    span_id: str | None = None


class TraceSpan(BaseModel):
    trace_id: str
    span_id: str
    parent_span_id: str | None = None
    service: str
    operation: str
    duration_ms: int
    status: Literal["ok", "error"]
    attributes: dict[str, Any] = Field(default_factory=dict)


class MetricPoint(BaseModel):
    service: str
    metric: str
    value: float
    unit: str
    timestamp: datetime
    attributes: dict[str, Any] = Field(default_factory=dict)


class Evidence(BaseModel):
    id: str
    event_id: str
    source: TelemetryKind
    service: str
    quote: str
    weight: float = Field(ge=0, le=1)


class Hypothesis(BaseModel):
    id: str
    title: str
    state: HypothesisState
    confidence: float = Field(ge=0, le=1)
    summary: str
    rationale: str
    evidence: list[Evidence] = Field(default_factory=list)
    recommended_actions: list[str] = Field(default_factory=list)


class Postmortem(BaseModel):
    incident_id: str
    title: str
    generated_at: datetime = Field(default_factory=utc_now)
    ai_provider: str = "mock"
    source_hypothesis_id: str = ""
    confidence: float = Field(default=0, ge=0, le=1)
    citation_coverage: float = Field(default=0, ge=0, le=1)
    executive_summary: str
    root_cause: str
    impact: str
    timeline: list[str]
    evidence: list[Evidence]
    corrective_actions: list[str]
    markdown: str


class ReplayRequest(BaseModel):
    scenario_id: Literal["checkout-timeout"] = "checkout-timeout"
    speed: float = Field(default=0.2, ge=0, le=3)


class StreamEnvelope(BaseModel):
    type: StreamEventType
    incident_id: str
    payload: dict[str, Any]
