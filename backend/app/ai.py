from __future__ import annotations

import os
from textwrap import dedent

import httpx

from .models import Evidence, Hypothesis, Incident, Postmortem, TelemetryEvent, utc_now
from .settings import settings


class PostmortemWriter:
    async def generate(self, incident: Incident, events: list[TelemetryEvent], hypotheses: list[Hypothesis]) -> Postmortem:
        mode = settings.ai_mode.lower()
        if mode != "mock" and os.getenv("OPENAI_API_KEY"):
            try:
                markdown = await self._generate_with_openai(incident, events, hypotheses)
                return self._from_markdown(incident, events, hypotheses, markdown, ai_provider="openai-compatible")
            except httpx.HTTPError:
                return self._mock(incident, events, hypotheses)
        return self._mock(incident, events, hypotheses)

    async def _generate_with_openai(self, incident: Incident, events: list[TelemetryEvent], hypotheses: list[Hypothesis]) -> str:
        base_url = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
        model = os.getenv("OPENAI_MODEL", "gpt-4.1-mini")
        top = hypotheses[0]
        evidence_lines = "\n".join(f"- {item.id}: {item.quote}" for item in top.evidence)
        prompt = dedent(
            f"""
            Write a concise engineering postmortem in Markdown.
            Incident: {incident.title}
            Impact: {incident.customer_impact}
            Top hypothesis: {top.title}
            Evidence:
            {evidence_lines}
            Requirements: cite evidence IDs inline, avoid unsupported claims, include corrective actions.
            """
        ).strip()
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.post(
                f"{base_url}/chat/completions",
                headers={"Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}"},
                json={
                    "model": model,
                    "messages": [
                        {"role": "system", "content": "You write precise, evidence-grounded incident postmortems."},
                        {"role": "user", "content": prompt},
                    ],
                    "temperature": 0.2,
                },
            )
            response.raise_for_status()
        data = response.json()
        return data["choices"][0]["message"]["content"]

    def _from_markdown(
        self,
        incident: Incident,
        events: list[TelemetryEvent],
        hypotheses: list[Hypothesis],
        markdown: str,
        ai_provider: str = "mock",
    ) -> Postmortem:
        top = hypotheses[0]
        markdown = self._ensure_evidence_register(markdown, top.evidence)
        return Postmortem(
            incident_id=incident.id,
            title=f"Postmortem: {incident.title}",
            generated_at=utc_now(),
            ai_provider=ai_provider,
            source_hypothesis_id=top.id,
            confidence=top.confidence,
            citation_coverage=self._citation_coverage(markdown, top.evidence),
            executive_summary=top.summary,
            root_cause=top.title,
            impact=incident.customer_impact,
            timeline=self._timeline(events),
            evidence=top.evidence,
            corrective_actions=top.recommended_actions,
            markdown=markdown,
        )

    def _mock(self, incident: Incident, events: list[TelemetryEvent], hypotheses: list[Hypothesis]) -> Postmortem:
        top = hypotheses[0] if hypotheses else Hypothesis(
            id="hyp_no_signal",
            title="Insufficient evidence",
            state="low_confidence",
            confidence=0.2,
            summary="The replay does not contain enough correlated evidence to identify a confident root cause.",
            rationale="No strong telemetry cluster was available.",
            evidence=[],
            recommended_actions=["Collect more telemetry before assigning ownership."],
        )
        timeline = self._timeline(events)
        evidence = top.evidence
        citations = ", ".join(item.id for item in evidence) or "no evidence IDs"
        actions = "\n".join(f"- {action}" for action in top.recommended_actions)
        timeline_md = "\n".join(f"- {item}" for item in timeline)
        evidence_md = "\n".join(f"- `{item.id}` ({item.service}/{item.source}): {item.quote}" for item in evidence)
        confidence_note = (
            f"{round(top.confidence * 100)}% confidence, marked `{top.state}`. "
            "Claims below are limited to cited telemetry evidence."
        )
        markdown = dedent(
            f"""
            # Postmortem: {incident.title}

            ## Executive Summary
            {top.summary} Evidence: {citations}.

            ## Confidence
            {confidence_note}

            ## Impact
            {incident.customer_impact}

            ## Root Cause
            {top.title}. {top.rationale}

            ## Timeline
            {timeline_md}

            ## Evidence
            {evidence_md}

            ## Corrective Actions
            {actions}
            """
        ).strip()
        return Postmortem(
            incident_id=incident.id,
            title=f"Postmortem: {incident.title}",
            generated_at=utc_now(),
            ai_provider="mock",
            source_hypothesis_id=top.id,
            confidence=top.confidence,
            citation_coverage=self._citation_coverage(markdown, evidence),
            executive_summary=top.summary,
            root_cause=top.title,
            impact=incident.customer_impact,
            timeline=timeline,
            evidence=evidence,
            corrective_actions=top.recommended_actions,
            markdown=markdown,
        )

    def _timeline(self, events: list[TelemetryEvent]) -> list[str]:
        return [
            f"+{event.offset_ms // 1000:02d}s {event.service}: {event.message}"
            for event in sorted(events, key=lambda item: item.offset_ms)
            if event.severity in {"warn", "error", "critical"}
        ][:8]

    def _ensure_evidence_register(self, markdown: str, evidence: list[Evidence]) -> str:
        missing = [item for item in evidence if item.id not in markdown]
        if not missing:
            return markdown
        evidence_md = "\n".join(f"- `{item.id}` ({item.service}/{item.source}): {item.quote}" for item in missing)
        return f"{markdown.rstrip()}\n\n## Evidence Register\n{evidence_md}"

    def _citation_coverage(self, markdown: str, evidence: list[Evidence]) -> float:
        if not evidence:
            return 0
        cited = sum(1 for item in evidence if item.id in markdown)
        return round(cited / len(evidence), 3)
