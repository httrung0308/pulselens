import { expect, test } from "@playwright/test";

const incident = {
  id: "inc_demo",
  scenario_id: "checkout-timeout",
  title: "Checkout timeout spike",
  status: "investigating",
  started_at: "2026-05-21T10:00:00Z",
  updated_at: "2026-05-21T10:00:16Z",
  impacted_services: ["web", "checkout-api", "payment-service", "queue-worker"],
  customer_impact: "Checkout success rate fell from 99.2% to 87.4% for 18 minutes.",
  service_map: [
    { source: "web", target: "checkout-api", relationship: "submits orders", risk: "normal" },
    { source: "checkout-api", target: "payment-service", relationship: "authorizes cards", risk: "critical" },
    { source: "checkout-api", target: "queue-worker", relationship: "enqueues retries", risk: "degraded" }
  ]
};

const events = [
  {
    id: "evt_010",
    incident_id: "inc_demo",
    offset_ms: 8400,
    timestamp: "2026-05-21T10:00:08Z",
    kind: "metric",
    service: "payment-service",
    severity: "critical",
    name: "payment.p95_latency",
    message: "Payment p95 latency peaked at 4860 ms.",
    attributes: { value: 4860, unit: "ms", baseline: 900 },
    trace_id: null,
    span_id: null
  },
  {
    id: "evt_011",
    incident_id: "inc_demo",
    offset_ms: 9300,
    timestamp: "2026-05-21T10:00:09Z",
    kind: "trace",
    service: "checkout-api",
    severity: "error",
    name: "POST /checkout",
    message: "Checkout trace waited on payment-service for 4210 ms before returning 504.",
    attributes: { duration_ms: 4380, status: "error", blocked_on: "payment-service" },
    trace_id: "trc_d4",
    span_id: "spn_root_2"
  }
];

const hypothesis = {
  id: "hyp_payment_retry_amplification",
  title: "Payment latency amplified by checkout retries",
  state: "supported",
  confidence: 0.92,
  summary: "Payment authorization latency crossed the checkout timeout budget, then retries multiplied upstream load.",
  rationale: "Payment latency, checkout 504s, and retry growth align in the same incident window.",
  evidence: [
    {
      id: "ev_evt_010",
      event_id: "evt_010",
      source: "metric",
      service: "payment-service",
      quote: "Payment p95 latency peaked at 4860 ms.",
      weight: 0.96
    }
  ],
  recommended_actions: ["Keep checkout retry throttle enabled while payment latency remains above 1200 ms."]
};

const postmortem = {
  incident_id: "inc_demo",
  title: "Postmortem: Checkout timeout spike",
  generated_at: "2026-05-21T10:01:00Z",
  executive_summary: hypothesis.summary,
  root_cause: hypothesis.title,
  impact: incident.customer_impact,
  timeline: ["+08s payment-service: Payment p95 latency peaked at 4860 ms."],
  evidence: hypothesis.evidence,
  corrective_actions: hypothesis.recommended_actions,
  markdown: "# Postmortem: Checkout timeout spike\n\nEvidence: ev_evt_010\n\nRoot cause: Payment latency amplified by checkout retries."
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ({ wsMessages }) => {
      class MockWebSocket {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;
        readyState = MockWebSocket.CONNECTING;
        onopen: ((event: Event) => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;
        onclose: ((event: CloseEvent) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;

        constructor() {
          setTimeout(() => {
            this.readyState = MockWebSocket.OPEN;
            this.onopen?.(new Event("open"));
            wsMessages.forEach((message, index) => {
              setTimeout(() => {
                this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(message) }));
              }, 25 + index * 20);
            });
          }, 10);
        }

        close() {
          this.readyState = MockWebSocket.CLOSED;
          this.onclose?.(new CloseEvent("close"));
        }

        send() {}
      }

      window.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    },
    {
      wsMessages: [
        { type: "status_update", incident_id: "inc_demo", payload: incident },
        ...events.map((event) => ({ type: "telemetry_event", incident_id: "inc_demo", payload: event })),
        { type: "finding", incident_id: "inc_demo", payload: hypothesis }
      ]
    }
  );

  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      await route.continue();
      return;
    }
    if (url.port !== "8000") {
      await route.continue();
      return;
    }
    if (url.pathname === "/incidents" && request.method() === "GET") {
      await route.fulfill({ json: [] });
      return;
    }
    if (url.pathname === "/incidents/replay" && request.method() === "POST") {
      await route.fulfill({ json: incident });
      return;
    }
    if (url.pathname === "/incidents/inc_demo/timeline") {
      await route.fulfill({ json: events });
      return;
    }
    if (url.pathname === "/incidents/inc_demo/analyze") {
      await route.fulfill({ json: [hypothesis] });
      return;
    }
    if (url.pathname === "/incidents/inc_demo/postmortem") {
      await route.fulfill({ json: postmortem });
      return;
    }
    await route.fulfill({ status: 404, json: { detail: "mock route missing" } });
  });
});

test("replays an incident, shows cited evidence, and renders a postmortem", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: /Start replay/i }).click();

  await expect(page.getByText("Payment latency amplified by checkout retries")).toBeVisible();
  await expect(page.getByText("ev_evt_010")).toBeVisible();

  await page.getByRole("button", { name: "Evidence" }).click();
  await expect(page.getByText("Payment p95 latency peaked at 4860 ms.")).toBeVisible();

  await page.getByRole("button", { name: "Services" }).click();
  await expect(page.getByText("authorizes cards")).toBeVisible();

  await page.getByRole("button", { name: "Postmortem" }).click();
  await page.getByRole("button", { name: /^Generate$/ }).last().click();
  await expect(page.getByText("# Postmortem: Checkout timeout spike")).toBeVisible();
});
