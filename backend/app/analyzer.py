from __future__ import annotations

from .models import Evidence, Hypothesis, Incident, TelemetryEvent


class IncidentAnalyzer:
    def analyze(self, incident: Incident, events: list[TelemetryEvent]) -> list[Hypothesis]:
        payment_latency = self._matching(events, "payment-service", "payment.p95_latency")
        checkout_errors = self._matching(events, "checkout-api", "checkout.error_rate")
        retries = [
            event
            for event in events
            if "retry" in event.name or "retry" in event.message.lower() or "Retry" in event.message
        ]
        payment_traces = [
            event
            for event in events
            if event.service == "payment-service"
            and event.kind == "trace"
            and event.attributes.get("duration_ms", 0) >= 2500
        ]
        inventory_health = self._matching(events, "inventory-service", "inventory.p95_latency")

        top_evidence = self._evidence(payment_latency[-2:] + payment_traces[-1:] + retries[-2:] + checkout_errors[-1:])
        has_strong_signal = len(top_evidence) >= 3
        top_confidence = 0.92 if has_strong_signal else 0.58

        hypotheses = [
            Hypothesis(
                id="hyp_payment_retry_amplification",
                title="Payment latency amplified by checkout retries",
                state="supported" if has_strong_signal else "low_confidence",
                confidence=top_confidence,
                summary=(
                    "Payment authorization latency crossed the checkout timeout budget, then checkout and worker retries "
                    "multiplied upstream load."
                ),
                rationale=(
                    "The strongest evidence links payment-service p95 latency, failed AuthorizePayment spans, checkout 5xx "
                    "growth, and retry queue depth in the same incident window."
                ),
                evidence=top_evidence,
                recommended_actions=[
                    "Keep checkout retry throttle enabled while payment latency remains above 1200 ms.",
                    "Reduce card-network timeout budget and add jittered backoff for payment retries.",
                    "Page the payment-service owner with trace IDs trc_b2 and trc_d4.",
                ],
            ),
            Hypothesis(
                id="hyp_inventory_regression",
                title="Inventory service regression",
                state="low_confidence",
                confidence=0.21 if inventory_health else 0.12,
                summary="Inventory stayed near baseline, so it is unlikely to be the primary checkout bottleneck.",
                rationale="The available inventory metric does not align with the checkout error spike.",
                evidence=self._evidence(inventory_health[-1:]),
                recommended_actions=["Keep inventory on the watch list, but do not route mitigation there first."],
            ),
            Hypothesis(
                id="hyp_frontend_release",
                title="Frontend release introduced checkout errors",
                state="low_confidence",
                confidence=0.18,
                summary="No deployment or browser-side error evidence appears in the replayed telemetry.",
                rationale="The timeline points to backend payment waits rather than client rendering or form submission failures.",
                evidence=self._evidence(events[:1]),
                recommended_actions=["Check deploy history only after payment-service mitigation is underway."],
            ),
        ]
        return sorted(hypotheses, key=lambda item: item.confidence, reverse=True)

    def _matching(self, events: list[TelemetryEvent], service: str, name: str) -> list[TelemetryEvent]:
        return [event for event in events if event.service == service and event.name == name]

    def _evidence(self, events: list[TelemetryEvent]) -> list[Evidence]:
        seen: set[str] = set()
        evidence: list[Evidence] = []
        for event in events:
            if event.id in seen:
                continue
            seen.add(event.id)
            evidence.append(
                Evidence(
                    id=f"ev_{event.id}",
                    event_id=event.id,
                    source=event.kind,
                    service=event.service,
                    quote=event.message,
                    weight=self._weight(event),
                )
            )
        return evidence

    def _weight(self, event: TelemetryEvent) -> float:
        if event.severity == "critical":
            return 0.96
        if event.severity == "error":
            return 0.88
        if event.severity == "warn":
            return 0.72
        return 0.48
