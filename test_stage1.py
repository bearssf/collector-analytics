#!/usr/bin/env python3
"""Smoke test for stage1_decomposition (requires AWS Bedrock env + credentials)."""

from __future__ import annotations

import json

from stage1_decomposition import decompose_research_topic


def main() -> None:
    result = decompose_research_topic(
        title="Critical thinking skills and dispositions in intercultural business relationship formation",
        keywords=[
            "critical thinking",
            "intercultural competence",
            "business relationships",
            "dispositions",
        ],
        project_type="dissertation",
    )
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
