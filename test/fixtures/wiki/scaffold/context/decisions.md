---
name: decisions
description: Architectural decisions
---

# Decisions

<!-- mex:entity
id: mx_01J0DEC1S10NR0TATE7K9MNP
type: decision
status: promoted
revision: 1
topics: [mx_01J0T0P1CAUTHENT1CAT10N5N]
sources:
  - type: commit
    ref: 8f21a3c
-->
## Rotate refresh tokens

Refresh tokens are single-use and rotated after every successful refresh. The
implementation lives in [rotateRefreshToken](mex://function:a3f8c21d9e4b7f60a1c2d3e4f5061728).

<!-- mex:entity
id: mx_01J0DEC1S10NCACHE4B6XQRST
type: decision
status: deprecated
revision: 2
relations:
  - type: supersedes
    target: mx_01J0DEC1S10NR0TATE7K9MNP
-->
## Cache session lookups

Superseded by the gateway-level cache.
