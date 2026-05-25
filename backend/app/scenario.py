from __future__ import annotations

from datetime import timedelta

from .models import Incident, ServiceDependency, TelemetryEvent, utc_now


def checkout_incident() -> Incident:
    return Incident(
        scenario_id="checkout-timeout",
        title="Checkout timeout spike",
        customer_impact="Checkout success rate fell from 99.2% to 87.4% for 18 minutes.",
        impacted_services=["web", "checkout-api", "payment-service", "queue-worker"],
        service_map=[
            ServiceDependency(source="web", target="checkout-api", relationship="submits orders"),
            ServiceDependency(source="checkout-api", target="payment-service", relationship="authorizes cards", risk="critical"),
            ServiceDependency(source="checkout-api", target="inventory-service", relationship="reserves stock"),
            ServiceDependency(source="checkout-api", target="queue-worker", relationship="enqueues retries", risk="degraded"),
            ServiceDependency(source="payment-service", target="card-network", relationship="external authorization", risk="critical"),
        ],
    )


def checkout_timeout_events(incident_id: str) -> list[TelemetryEvent]:
    base = utc_now()

    def event(
        index: int,
        offset_ms: int,
        kind: str,
        service: str,
        severity: str,
        name: str,
        message: str,
        attributes: dict,
        trace_id: str | None = None,
        span_id: str | None = None,
    ) -> TelemetryEvent:
        return TelemetryEvent(
            id=f"evt_{index:03d}",
            incident_id=incident_id,
            offset_ms=offset_ms,
            timestamp=base + timedelta(milliseconds=offset_ms),
            kind=kind,  # type: ignore[arg-type]
            service=service,
            severity=severity,  # type: ignore[arg-type]
            name=name,
            message=message,
            attributes=attributes,
            trace_id=trace_id,
            span_id=span_id,
        )

    return [
        event(1, 0, "metric", "checkout-api", "info", "checkout.success_rate", "Checkout success rate stable at 99.2%.", {"value": 99.2, "unit": "percent"}),
        event(2, 900, "trace", "checkout-api", "info", "POST /checkout", "Checkout request completed in 241 ms.", {"duration_ms": 241, "status": "ok"}, "trc_a1", "spn_root"),
        event(3, 1800, "metric", "payment-service", "warn", "payment.p95_latency", "Payment p95 latency rose to 1440 ms, above the 900 ms baseline.", {"value": 1440, "unit": "ms", "baseline": 900}),
        event(4, 2600, "log", "payment-service", "warn", "gateway.timeout", "Card-network authorization timed out after 3000 ms.", {"gateway": "card-network", "timeout_ms": 3000}, "trc_b2", "spn_pay_1"),
        event(5, 3400, "trace", "payment-service", "error", "AuthorizePayment", "AuthorizePayment span failed after 3288 ms.", {"duration_ms": 3288, "status": "error", "dependency": "card-network"}, "trc_b2", "spn_pay_1"),
        event(6, 4300, "metric", "checkout-api", "error", "checkout.error_rate", "Checkout 5xx error rate increased to 9.8%.", {"value": 9.8, "unit": "percent", "baseline": 0.3}),
        event(7, 5200, "log", "checkout-api", "warn", "payment.retry", "Retrying payment authorization for order batch after upstream timeout.", {"retry_count": 2, "upstream": "payment-service"}, "trc_c3", "spn_checkout_1"),
        event(8, 6100, "metric", "queue-worker", "warn", "retry.queue_depth", "Payment retry queue depth reached 1260 jobs.", {"value": 1260, "unit": "jobs", "baseline": 120}),
        event(9, 7200, "log", "queue-worker", "error", "retry.amplification", "Retry worker fanned out duplicate payment attempts for timed-out checkout requests.", {"retry_multiplier": 4.6, "upstream": "payment-service"}),
        event(10, 8400, "metric", "payment-service", "critical", "payment.p95_latency", "Payment p95 latency peaked at 4860 ms.", {"value": 4860, "unit": "ms", "baseline": 900}),
        event(11, 9300, "trace", "checkout-api", "error", "POST /checkout", "Checkout trace waited on payment-service for 4210 ms before returning 504.", {"duration_ms": 4380, "status": "error", "blocked_on": "payment-service"}, "trc_d4", "spn_root_2"),
        event(12, 10400, "metric", "inventory-service", "info", "inventory.p95_latency", "Inventory p95 latency remained near baseline at 118 ms.", {"value": 118, "unit": "ms", "baseline": 130}),
        event(13, 11800, "log", "checkout-api", "info", "retry.throttle", "Checkout retry throttle enabled for payment authorization.", {"retry_limit": 1, "change": "enabled"}),
        event(14, 13400, "metric", "checkout-api", "warn", "checkout.success_rate", "Checkout success rate recovered to 96.6% after retry throttle.", {"value": 96.6, "unit": "percent"}),
        event(15, 15000, "metric", "payment-service", "warn", "payment.p95_latency", "Payment p95 latency fell to 1280 ms after card-network timeout budget was reduced.", {"value": 1280, "unit": "ms", "baseline": 900}),
    ]
