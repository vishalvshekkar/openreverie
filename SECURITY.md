# Security policy

openreverie stores highly sensitive personal data. Security reports are taken seriously and handled with priority.

## Reporting a vulnerability

Email vishalvshekkar@gmail.com with details. Please do not open a public issue for anything that could expose user data. You will get an acknowledgment within a few days.

Especially relevant classes of issues:

- Anything that could exfiltrate memory folder contents (including through prompt injection into the agent's tools)
- Anything that could corrupt or silently rewrite transcripts or the graph log
- API key handling and config file permission problems

## Web interface

The `reverie web` command runs a local server. Its security posture is deliberately minimal, because it is meant for one person on one machine:

- The canonical origin is exactly `http://127.0.0.1:<port>`; the server binds to loopback only, so nothing on the network can reach it.
- The server sends no CORS headers. Write requests require an `Origin` header equal to the canonical origin, which only same-origin pages send.
- Access is admitted by a bootstrap token: 32 random bytes, base64url-encoded, single-use, and bound to the running process. It expires five minutes after startup. Exchanging it sets an `HttpOnly` session cookie.
- The token is printed to your terminal. Anyone who can read your terminal or your local network traffic to loopback effectively has access, so protect your own machine session. Do not paste the bootstrap URL into shared notes or logs.

This is a single-user, local trust model, not a multi-user or internet-facing one.
