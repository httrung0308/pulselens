from fastapi.testclient import TestClient

from app.analyzer import IncidentAnalyzer
from app.main import app, store
from app.scenario import checkout_incident, checkout_timeout_events
from app.store import IncidentStore


def setup_function() -> None:
    import asyncio

    asyncio.run(store.reset())


def test_replay_generates_ordered_timeline_and_supported_hypothesis() -> None:
    client = TestClient(app)

    response = client.post("/incidents/replay", json={"scenario_id": "checkout-timeout", "speed": 0})
    assert response.status_code == 200
    incident = response.json()

    timeline = client.get(f"/incidents/{incident['id']}/timeline").json()
    assert len(timeline) == 15
    assert [event["offset_ms"] for event in timeline] == sorted(event["offset_ms"] for event in timeline)

    hypotheses = client.post(f"/incidents/{incident['id']}/analyze").json()
    assert hypotheses[0]["id"] == "hyp_payment_retry_amplification"
    assert hypotheses[0]["confidence"] >= 0.9
    assert hypotheses[0]["state"] == "supported"
    assert len(hypotheses[0]["evidence"]) >= 4


def test_postmortem_contains_cited_evidence_and_markdown() -> None:
    client = TestClient(app)
    incident = client.post("/incidents/replay", json={"speed": 0}).json()

    postmortem = client.get(f"/incidents/{incident['id']}/postmortem").json()

    assert postmortem["title"].startswith("Postmortem:")
    assert "Payment latency amplified" in postmortem["root_cause"]
    assert postmortem["evidence"]
    assert postmortem["ai_provider"] == "mock"
    assert postmortem["confidence"] >= 0.9
    assert postmortem["citation_coverage"] == 1
    assert "`ev_evt_" in postmortem["markdown"]


def test_hypotheses_endpoint_returns_saved_analysis() -> None:
    client = TestClient(app)
    incident = client.post("/incidents/replay", json={"speed": 0}).json()

    client.post(f"/incidents/{incident['id']}/analyze")
    hypotheses = client.get(f"/incidents/{incident['id']}/hypotheses").json()

    assert hypotheses[0]["id"] == "hyp_payment_retry_amplification"
    assert hypotheses[0]["evidence"][0]["id"].startswith("ev_evt_")


def test_websocket_replays_existing_timeline_in_order() -> None:
    client = TestClient(app)
    incident = client.post("/incidents/replay", json={"speed": 0}).json()
    timeline = client.get(f"/incidents/{incident['id']}/timeline").json()

    with client.websocket_connect(f"/ws/incidents/{incident['id']}/stream") as websocket:
        first = websocket.receive_json()
        assert first["type"] == "status_update"
        streamed = [websocket.receive_json() for _ in range(len(timeline))]

    assert all(item["type"] == "telemetry_event" for item in streamed)
    assert [item["payload"]["offset_ms"] for item in streamed] == [event["offset_ms"] for event in timeline]


def test_unknown_scenario_returns_404() -> None:
    client = TestClient(app)
    response = client.post("/incidents/replay", json={"scenario_id": "not-real", "speed": 0})
    assert response.status_code == 422


def test_store_persists_incident_state_across_instances(tmp_path) -> None:
    import asyncio

    database_url = f"sqlite:///{tmp_path / 'pulselens-test.db'}"
    first_store = IncidentStore(database_url)
    incident = checkout_incident()
    events = checkout_timeout_events(incident.id)

    async def seed() -> None:
        await first_store.create_incident(incident)
        for event in events:
            await first_store.append_event(incident.id, event)
        hypotheses = IncidentAnalyzer().analyze(incident, events)
        await first_store.save_hypotheses(incident.id, hypotheses)

    asyncio.run(seed())

    second_store = IncidentStore(database_url)

    async def read_back() -> tuple[int, int]:
        timeline = await second_store.timeline(incident.id)
        hypotheses = await second_store.hypotheses(incident.id)
        return len(timeline), len(hypotheses)

    timeline_count, hypothesis_count = asyncio.run(read_back())
    assert timeline_count == 15
    assert hypothesis_count == 3
