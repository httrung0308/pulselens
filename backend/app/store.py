from __future__ import annotations

import asyncio
from collections import defaultdict
from copy import deepcopy
from typing import Any

from sqlalchemy import (
    JSON,
    Column,
    DateTime,
    Integer,
    MetaData,
    PrimaryKeyConstraint,
    String,
    Table,
    create_engine,
    delete,
    insert,
    select,
)
from sqlalchemy.engine import Engine

from .models import Hypothesis, Incident, Postmortem, StreamEnvelope, TelemetryEvent, utc_now
from .settings import settings


metadata = MetaData()

incidents_table = Table(
    "incidents",
    metadata,
    Column("id", String(255), primary_key=True),
    Column("scenario_id", String(255), nullable=False),
    Column("status", String(64), nullable=False),
    Column("started_at", DateTime(timezone=True), nullable=False),
    Column("updated_at", DateTime(timezone=True), nullable=False),
    Column("data", JSON, nullable=False),
)

telemetry_events_table = Table(
    "telemetry_events",
    metadata,
    Column("incident_id", String(255), nullable=False),
    Column("event_id", String(255), nullable=False),
    Column("offset_ms", Integer, nullable=False),
    Column("data", JSON, nullable=False),
    PrimaryKeyConstraint("incident_id", "event_id"),
)

hypotheses_table = Table(
    "hypotheses",
    metadata,
    Column("incident_id", String(255), nullable=False),
    Column("hypothesis_id", String(255), nullable=False),
    Column("rank", Integer, nullable=False),
    Column("data", JSON, nullable=False),
    PrimaryKeyConstraint("incident_id", "hypothesis_id"),
)

postmortems_table = Table(
    "postmortems",
    metadata,
    Column("incident_id", String(255), primary_key=True),
    Column("data", JSON, nullable=False),
)


class IncidentStore:
    def __init__(self, database_url: str | None = None) -> None:
        self.database_url = database_url or settings.database_url
        self.engine = self._create_engine(self.database_url)
        metadata.create_all(self.engine)
        self._subscribers: dict[str, set[asyncio.Queue[StreamEnvelope]]] = defaultdict(set)
        self._lock = asyncio.Lock()

    @property
    def storage_label(self) -> str:
        return self.engine.url.get_backend_name()

    def _create_engine(self, database_url: str) -> Engine:
        connect_args = {"check_same_thread": False} if database_url.startswith("sqlite") else {}
        return create_engine(database_url, future=True, connect_args=connect_args)

    async def create_incident(self, incident: Incident) -> Incident:
        async with self._lock:
            self._upsert_incident_unlocked(incident)
            return deepcopy(incident)

    async def list_incidents(self) -> list[Incident]:
        async with self._lock:
            with self.engine.begin() as connection:
                rows = connection.execute(
                    select(incidents_table.c.data).order_by(incidents_table.c.started_at.desc())
                ).all()
            return [Incident.model_validate(row.data) for row in rows]

    async def get_incident(self, incident_id: str) -> Incident | None:
        async with self._lock:
            return self._get_incident_unlocked(incident_id)

    async def update_status(self, incident_id: str, status: str) -> Incident | None:
        async with self._lock:
            incident = self._get_incident_unlocked(incident_id)
            if not incident:
                return None
            incident.status = status  # type: ignore[assignment]
            incident.updated_at = utc_now()
            self._upsert_incident_unlocked(incident)
            return deepcopy(incident)

    async def append_event(self, incident_id: str, event: TelemetryEvent) -> TelemetryEvent:
        async with self._lock:
            with self.engine.begin() as connection:
                connection.execute(
                    delete(telemetry_events_table).where(
                        telemetry_events_table.c.incident_id == incident_id,
                        telemetry_events_table.c.event_id == event.id,
                    )
                )
                connection.execute(
                    insert(telemetry_events_table).values(
                        incident_id=incident_id,
                        event_id=event.id,
                        offset_ms=event.offset_ms,
                        data=event.model_dump(mode="json"),
                    )
                )
            incident = self._get_incident_unlocked(incident_id)
            if incident:
                incident.updated_at = utc_now()
                self._upsert_incident_unlocked(incident)
            return deepcopy(event)

    async def timeline(self, incident_id: str) -> list[TelemetryEvent]:
        async with self._lock:
            with self.engine.begin() as connection:
                rows = connection.execute(
                    select(telemetry_events_table.c.data)
                    .where(telemetry_events_table.c.incident_id == incident_id)
                    .order_by(telemetry_events_table.c.offset_ms)
                ).all()
            return [TelemetryEvent.model_validate(row.data) for row in rows]

    async def save_hypotheses(self, incident_id: str, hypotheses: list[Hypothesis]) -> list[Hypothesis]:
        async with self._lock:
            with self.engine.begin() as connection:
                connection.execute(delete(hypotheses_table).where(hypotheses_table.c.incident_id == incident_id))
                for rank, hypothesis in enumerate(hypotheses):
                    connection.execute(
                        insert(hypotheses_table).values(
                            incident_id=incident_id,
                            hypothesis_id=hypothesis.id,
                            rank=rank,
                            data=hypothesis.model_dump(mode="json"),
                        )
                    )
            incident = self._get_incident_unlocked(incident_id)
            if incident:
                incident.status = "investigating"
                incident.updated_at = utc_now()
                self._upsert_incident_unlocked(incident)
            return deepcopy(hypotheses)

    async def hypotheses(self, incident_id: str) -> list[Hypothesis]:
        async with self._lock:
            with self.engine.begin() as connection:
                rows = connection.execute(
                    select(hypotheses_table.c.data)
                    .where(hypotheses_table.c.incident_id == incident_id)
                    .order_by(hypotheses_table.c.rank)
                ).all()
            return [Hypothesis.model_validate(row.data) for row in rows]

    async def save_postmortem(self, postmortem: Postmortem) -> Postmortem:
        async with self._lock:
            with self.engine.begin() as connection:
                connection.execute(delete(postmortems_table).where(postmortems_table.c.incident_id == postmortem.incident_id))
                connection.execute(
                    insert(postmortems_table).values(
                        incident_id=postmortem.incident_id,
                        data=postmortem.model_dump(mode="json"),
                    )
                )
            incident = self._get_incident_unlocked(postmortem.incident_id)
            if incident:
                incident.status = "resolved"
                incident.updated_at = utc_now()
                self._upsert_incident_unlocked(incident)
            return deepcopy(postmortem)

    async def postmortem(self, incident_id: str) -> Postmortem | None:
        async with self._lock:
            with self.engine.begin() as connection:
                row = connection.execute(
                    select(postmortems_table.c.data).where(postmortems_table.c.incident_id == incident_id)
                ).first()
            return Postmortem.model_validate(row.data) if row else None

    async def publish(self, incident_id: str, envelope: StreamEnvelope) -> None:
        subscribers = list(self._subscribers.get(incident_id, set()))
        for queue in subscribers:
            await queue.put(envelope)

    async def subscribe(self, incident_id: str) -> asyncio.Queue[StreamEnvelope]:
        queue: asyncio.Queue[StreamEnvelope] = asyncio.Queue()
        async with self._lock:
            self._subscribers[incident_id].add(queue)
        return queue

    async def unsubscribe(self, incident_id: str, queue: asyncio.Queue[StreamEnvelope]) -> None:
        async with self._lock:
            self._subscribers[incident_id].discard(queue)

    async def reset(self) -> None:
        async with self._lock:
            with self.engine.begin() as connection:
                connection.execute(delete(postmortems_table))
                connection.execute(delete(hypotheses_table))
                connection.execute(delete(telemetry_events_table))
                connection.execute(delete(incidents_table))
            self._subscribers.clear()

    def _get_incident_unlocked(self, incident_id: str) -> Incident | None:
        with self.engine.begin() as connection:
            row = connection.execute(select(incidents_table.c.data).where(incidents_table.c.id == incident_id)).first()
        return Incident.model_validate(row.data) if row else None

    def _upsert_incident_unlocked(self, incident: Incident) -> None:
        with self.engine.begin() as connection:
            connection.execute(delete(incidents_table).where(incidents_table.c.id == incident.id))
            connection.execute(
                insert(incidents_table).values(
                    id=incident.id,
                    scenario_id=incident.scenario_id,
                    status=incident.status,
                    started_at=incident.started_at,
                    updated_at=incident.updated_at,
                    data=incident.model_dump(mode="json"),
                )
            )


def envelope(event_type: str, incident_id: str, payload: dict[str, Any]) -> StreamEnvelope:
    return StreamEnvelope(type=event_type, incident_id=incident_id, payload=payload)  # type: ignore[arg-type]
