# Security policy

openreverie stores highly sensitive personal data. Security reports are taken seriously and handled with priority.

## Reporting a vulnerability

Email vishalvshekkar@gmail.com with details. Please do not open a public issue for anything that could expose user data. You will get an acknowledgment within a few days.

Especially relevant classes of issues:

- Anything that could exfiltrate memory folder contents (including through prompt injection into the agent's tools)
- Anything that could corrupt or silently rewrite transcripts or the graph log
- API key handling and config file permission problems

## Supported versions

The project is pre-release; only the latest main branch is supported.
