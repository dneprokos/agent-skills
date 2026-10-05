# API Test Scenario Backfill

Bootstrap a `requirements/` RTM file from **existing tests** — for when a repo already has API test coverage but no API Test Scenario RTM was ever written.

## Quick Start

```
# Backfill from a whole test folder (auto-detects framework)
/api-test-scenario-rtm-backfill tests/api/gateway_api/users/

# Backfill from a single spec file
/api-test-scenario-rtm-backfill tests/api/gateway_api/users/get-users.spec.ts

# Explicitly supply the framework (skips auto-detection)
/api-test-scenario-rtm-backfill tests/api/gateway_api/users/ --framework playwright
```

> If an RTM file already exists for the resource group, this skill stops and tells you to use `api-test-scenario-rtm-updater` instead.

---

## What it does

1. **Discovers** all test cases in the given path (auto-detects or uses `--framework`).
2. **Generates** the canonical scenario set per endpoint against the same coverage checklist used by `api-test-scenario-rtm-generator`.
3. **Maps** each existing test onto a generated scenario row — fills E2E Test Name, aligns HTTP status and expected result from assertions, notes skipped tests.
4. **Adds** unmapped tests as new scenario rows (nothing is discarded).
5. **Writes** `requirements/<group>/<resource>.md` with a realistic per-method status (🟡/🔵/🟢).
6. **Prints** a backfill report: mapped, unmapped, coverage gaps, open warnings.

---

## Skill family

| Skill | Starting point | Produces |
|---|---|---|
| `api-test-scenario-rtm-generator` | Prompt / OpenAPI spec (no tests yet) | New API Test Scenario RTM from scratch |
| **`api-test-scenario-rtm-backfill`** | **Existing tests, no RTM** | **New API Test Scenario RTM mapped to those tests** |
| `api-test-scenario-rtm-updater` | Existing RTM + tests | RTM kept in sync |

---

## Supported frameworks

Playwright, Jest, NUnit, xUnit, pytest — see `references/test-frameworks.md` for
detection and parsing details.

---

## Output

One file created per resource group at `requirements/<group>/<resource>.md`, following
the same 8-column format and naming conventions as the generator:

| Scenario | Test Type | Description | Expected Result | HTTP Status | Recommended Test Level | E2E Test Name | Comment |
|---|---|---|---|---|---|---|---|
| Existing user | Happy Path | GET with valid UUID of existing user | User object returned | 200 | Integration | existing user - should return user | |
| No token | Security | GET without Authorization header | 401 Unauthorized | 401 | Integration | no auth - should return 401 | |

---

## Files

```
.github/skills/api-test-scenario-rtm-backfill/
├── SKILL.md                          # Main skill definition (6-step pipeline)
├── README.md                         # This file
├── references/
│   ├── test-frameworks.md            # Discovery + parsing patterns per framework
│   └── mapping-heuristics.md        # How to match tests → scenario rows
└── templates/
    └── backfill-report.md            # Backfill summary report format
```

Reuses (does **not** duplicate) from `api-test-scenario-rtm-generator`:
- `references/coverage-checklist.md`
- `config/validation-rules.json`
- `config/test-types.json`

---

## Companion skills

- **`api-test-scenario-rtm-generator`** — use when no tests exist yet.
- **`api-test-scenario-rtm-updater`** — use after backfill to keep the RTM in sync as tests change.
