from __future__ import annotations

import asyncio
from contextlib import suppress

from fastapi import BackgroundTasks, FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from .ai import PostmortemWriter
from .analyzer import IncidentAnalyzer
from .models import Hypothesis, Incident, Postmortem, ReplayRequest, TelemetryEvent
from .scenario import checkout_incident, checkout_timeout_events
from .settings import settings
from .store import IncidentStore, envelope


app = FastAPI(title="PulseLens API", version="0.1.0")
store = IncidentStore()
analyzer = IncidentAnalyzer()
writer = PostmortemWriter()

app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.cors_origins),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "storage": store.storage_label, "ai_mode": settings.ai_mode}


@app.get("/incidents", response_model=list[Incident])
async def list_incidents() -> list[Incident]:
    return await store.list_incidents()


@app.post("/incidents/replay", response_model=Incident)
async def replay_incident(request: ReplayRequest, background_tasks: BackgroundTasks) -> Incident:
    if request.scenario_id != "checkout-timeout":
        raise HTTPException(status_code=404, detail="Unknown scenario")
    incident = await store.create_incident(checkout_incident())
    background_tasks.add_task(run_replay, incident.id, request.speed)
    return incident


@app.get("/incidents/{incident_id}", response_model=Incident)
async def get_incident(incident_id: str) -> Incident:
    incident = await store.get_incident(incident_id)
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")
    return incident


@app.get("/incidents/{incident_id}/timeline", response_model=list[TelemetryEvent])
async def get_timeline(incident_id: str) -> list[TelemetryEvent]:
    if not await store.get_incident(incident_id):
        raise HTTPException(status_code=404, detail="Incident not found")
    return await store.timeline(incident_id)


@app.get("/incidents/{incident_id}/hypotheses", response_model=list[Hypothesis])
async def get_hypotheses(incident_id: str) -> list[Hypothesis]:
    if not await store.get_incident(incident_id):
        raise HTTPException(status_code=404, detail="Incident not found")
    return await store.hypotheses(incident_id)


@app.post("/incidents/{incident_id}/analyze", response_model=list[Hypothesis])
async def analyze_incident(incident_id: str) -> list[Hypothesis]:
    incident = await get_incident(incident_id)
    events = await store.timeline(incident_id)
    hypotheses = analyzer.analyze(incident, events)
    await store.save_hypotheses(incident_id, hypotheses)
    for hypothesis in hypotheses:
        await store.publish(
            incident_id,
            envelope("finding", incident_id, hypothesis.model_dump(mode="json")),
        )
    return hypotheses


@app.get("/incidents/{incident_id}/postmortem", response_model=Postmortem)
async def get_postmortem(incident_id: str) -> Postmortem:
    existing = await store.postmortem(incident_id)
    if existing:
        return existing
    incident = await get_incident(incident_id)
    events = await store.timeline(incident_id)
    hypotheses = await store.hypotheses(incident_id)
    if not hypotheses:
        hypotheses = analyzer.analyze(incident, events)
        await store.save_hypotheses(incident_id, hypotheses)
    postmortem = await writer.generate(incident, events, hypotheses)
    saved = await store.save_postmortem(postmortem)
    resolved = await store.get_incident(incident_id)
    if resolved:
        await store.publish(
            incident_id,
            envelope("status_update", incident_id, resolved.model_dump(mode="json")),
        )
    return saved


@app.websocket("/ws/incidents/{incident_id}/stream")
async def incident_stream(websocket: WebSocket, incident_id: str) -> None:
    incident = await store.get_incident(incident_id)
    if not incident:
        await websocket.close(code=4404)
        return

    await websocket.accept()
    queue = await store.subscribe(incident_id)
    try:
        await websocket.send_json(envelope("status_update", incident_id, incident.model_dump(mode="json")).model_dump(mode="json"))
        for event in await store.timeline(incident_id):
            await websocket.send_json(envelope("telemetry_event", incident_id, event.model_dump(mode="json")).model_dump(mode="json"))
        for hypothesis in await store.hypotheses(incident_id):
            await websocket.send_json(envelope("finding", incident_id, hypothesis.model_dump(mode="json")).model_dump(mode="json"))
        while True:
            item = await queue.get()
            await websocket.send_json(item.model_dump(mode="json"))
    except WebSocketDisconnect:
        pass
    finally:
        await store.unsubscribe(incident_id, queue)


async def run_replay(incident_id: str, speed: float) -> None:
    incident = await store.update_status(incident_id, "replaying")
    if incident:
        await store.publish(incident_id, envelope("status_update", incident_id, incident.model_dump(mode="json")))

    previous_offset = 0
    for index, event in enumerate(checkout_timeout_events(incident_id), start=1):
        delay_ms = max(event.offset_ms - previous_offset, 0)
        previous_offset = event.offset_ms
        if speed > 0 and delay_ms:
            await asyncio.sleep((delay_ms / 1000) * speed)
        saved = await store.append_event(incident_id, event)
        await store.publish(incident_id, envelope("telemetry_event", incident_id, saved.model_dump(mode="json")))
        if index in {7, 11, 15}:
            with suppress(HTTPException):
                await analyze_incident(incident_id)

    resolved = await store.update_status(incident_id, "investigating")
    if resolved:
        await store.publish(incident_id, envelope("status_update", incident_id, resolved.model_dump(mode="json")))
