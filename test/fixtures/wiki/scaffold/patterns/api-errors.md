---
name: api-error-pattern
description: Standard API error handling
triggers:
  - "API error"
  - "error response"
last_updated: 2026-08-22
edges:
  - target: context/architecture.md
    condition: when changing the gateway
mex:
  id: mx_01J0PATTERNAP1ERR0RS2JKLM
  type: pattern
  status: promoted
  revision: 1
  topics: [mx_01J0T0P1CAUTHENT1CAT10N5N]
  grounds_to:
    - node: "function:a3f8c21d9e4b7f60a1c2d3e4f5061728"
      fingerprint: "mh:64:9f2a4c6e"
---

# API error handling

Every handler returns a problem document rather than a bare string.
