# Backfill Report: `{{FILE_PATH}}`

**Source**: `{{TEST_PATH}}`
**Framework**: `{{FRAMEWORK}}`
**Generated**: `{{TIMESTAMP}}`

---

## Summary

| Metric | Count |
|---|---|
| Test files discovered | {{TEST_FILES_COUNT}} |
| Test cases discovered | {{TESTS_DISCOVERED}} |
| Tests mapped to generated scenarios | {{TESTS_MAPPED}} |
| Tests unmapped → added as new rows | {{TESTS_UNMAPPED}} |
| Generated scenario rows (canonical) | {{GENERATED_ROWS}} |
| Coverage gaps (scenarios with no test) | {{GAPS_COUNT}} |
| Open ⚠️ warnings | {{WARNINGS_COUNT}} |

---

## Per-method results

{{#each METHODS}}
### {{METHOD}} `{{ENDPOINT}}`

**Status**: {{STATUS}}
**Blocking gap** (if 🟡): {{BLOCKING_GAP}}

| Category | Count |
|---|---|
| Total scenario rows | {{TOTAL_ROWS}} |
| E2E/Integration rows linked | {{LINKED_ROWS}} / {{LINKABLE_ROWS}} |
| Skipped tests | {{SKIPPED_COUNT}} |
| Open ⚠️ warnings | {{WARNINGS}} |

{{/each}}

---

## Unmapped tests — added as new rows

These tests did not match any generated canonical scenario. A new scenario row was
derived from each and added to the RTM at the end of the relevant method section.
Verify that the description and test type are correct.

{{#each UNMAPPED_TESTS}}
- **`{{TEST_TITLE}}`** → added as `{{SCENARIO_LABEL}}` ({{TEST_TYPE}} / {{LEVEL}}) in `{{METHOD}} {{ENDPOINT}}`
{{/each}}

{{#if NO_UNMAPPED}}
_None — all discovered tests matched a generated scenario._
{{/if}}

---

## Coverage gaps (scenarios with no test yet)

These canonical scenarios were generated from the coverage checklist but no
existing test matched them. E2E Test Name is empty in the RTM.

{{#each GAPS}}
- `{{METHOD}} {{ENDPOINT}}` → **{{SCENARIO_LABEL}}** ({{TEST_TYPE}} / {{LEVEL}})
{{/each}}

{{#if NO_GAPS}}
_None — all generated scenarios have a matching test._
{{/if}}

---

## Open ⚠️ warnings

Warnings that could not be resolved from test assertions or a provided spec.
Confirm these with the team and then use `/api-test-scenario-rtm-updater {{FILE_PATH}}` to close them.

{{#each OPEN_WARNINGS}}
- `{{METHOD}} {{ENDPOINT}}`: ⚠️ {{WARNING_TEXT}}
{{/each}}

{{#if NO_WARNINGS}}
_None — all warnings were resolved by test assertions._
{{/if}}

---

## Next steps

1. Review the **unmapped test rows** and tighten their descriptions if needed.
2. Address the **coverage gaps** — write tests for the missing scenarios or decide to defer.
3. Resolve the **open ⚠️ warnings** with the team.
4. Use **`/api-test-scenario-rtm-updater {{FILE_PATH}}`** to keep the RTM in sync as tests change.
