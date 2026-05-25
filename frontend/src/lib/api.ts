import type { Hypothesis, Incident, Postmortem, StreamEnvelope, TelemetryEvent } from "./types";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {})
    }
  });
  if (!response.ok) {
    throw new Error(`PulseLens API returned ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export function listIncidents(): Promise<Incident[]> {
  return request<Incident[]>("/incidents");
}

export function startReplay(speed = 0.2): Promise<Incident> {
  return request<Incident>("/incidents/replay", {
    method: "POST",
    body: JSON.stringify({ scenario_id: "checkout-timeout", speed })
  });
}

export function getTimeline(incidentId: string): Promise<TelemetryEvent[]> {
  return request<TelemetryEvent[]>(`/incidents/${incidentId}/timeline`);
}

export function getHypotheses(incidentId: string): Promise<Hypothesis[]> {
  return request<Hypothesis[]>(`/incidents/${incidentId}/hypotheses`);
}

export function analyzeIncident(incidentId: string): Promise<Hypothesis[]> {
  return request<Hypothesis[]>(`/incidents/${incidentId}/analyze`, { method: "POST" });
}

export function getPostmortem(incidentId: string): Promise<Postmortem> {
  return request<Postmortem>(`/incidents/${incidentId}/postmortem`);
}

export function openIncidentStream(
  incidentId: string,
  onMessage: (event: StreamEnvelope) => void,
  onState?: (state: "open" | "closed" | "error") => void
): WebSocket {
  const wsUrl = `${API_URL.replace(/^http/, "ws")}/ws/incidents/${incidentId}/stream`;
  const socket = new WebSocket(wsUrl);
  socket.onopen = () => onState?.("open");
  socket.onclose = () => onState?.("closed");
  socket.onerror = () => onState?.("error");
  socket.onmessage = (message) => {
    onMessage(JSON.parse(message.data) as StreamEnvelope);
  };
  return socket;
}
