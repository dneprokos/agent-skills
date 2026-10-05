---
name: bug-report-formatter
description: >-
  Format messy bug reports, error logs, stack traces, or casual defect
  descriptions into a structured, Jira-ready bug report. Classifies severity
  and priority automatically. Optionally creates a Jira Bug ticket via the
  Atlassian MCP. Use this skill whenever the user says "format this bug",
  "write a bug report", "turn this error into a Jira ticket", "file a bug from
  these logs", "clean up this defect report", "create a bug ticket", "I found
  a bug — help me report it", or pastes a stack trace or error log and asks
  what to do with it.
argument-hint: "raw error, logs, description, or repro steps"
---

# Bug Report Formatter

Turn messy input into a clean, structured bug report — ready to paste into Jira or filed directly via the Atlassian MCP.

## When this skill fits

Use it for requests like:

- "format this bug report for me"
- "turn this stack trace into a Jira ticket"
- "write a proper defect report from these notes"
- "help me file a bug — here's what happened"
- "clean up this bug before sprint grooming"

Do **not** use it for:

- creating non-Bug issue types (use `jira-issue-creator` for tasks, stories, sub-tasks)
- triaging duplicates across existing Jira issues (use the triage-issue skill if available)
- writing test scenarios from an endpoint (use `api-test-scenario-rtm-generator`)

## Workflow

### 1. Accept raw input

The user may provide any combination of:

- error logs or stack traces (paste directly)
- a casual description ("clicking Save crashes the app")
- partial reproduction steps
- screenshots described in text

If the input contains **no indication of expected vs actual behavior** and **no steps to reproduce**, ask the user for the missing pieces — but ask at most two clarifying questions in a single message. Never block on optional details like environment or app version; use `Unknown` instead.

### 2. Classify severity and priority

Read [references/severity-guidelines.md](./references/severity-guidelines.md) to propose:

- **Severity**: Blocker / Critical / Major / Minor / Trivial
- **Priority**: High / Medium / Low

State your reasoning briefly (one line). The user can override before the report is created.

### 3. Format the report

Apply [references/bug-report-template.md](./references/bug-report-template.md) to produce a complete report with these sections:

1. **Title** — `[Area] Concise description of the failure`
2. **Environment** — OS, browser/client, app version, test environment
3. **Steps to Reproduce** — numbered, one action per step
4. **Expected Result**
5. **Actual Result**
6. **Severity / Priority**
7. **Logs / Attachments** — verbatim code blocks
8. **Additional Context**

Infer environment details from log headers or user-agent strings when possible. Mark anything that cannot be inferred as `Unknown`.

### 4. Present and confirm

Display the full formatted report in a single fenced markdown block. Then ask:

```text
Does this look good?
```

Offer exactly these two options:

- `OK` — proceed
- `Edit` — I want to change something

If the user chooses **Edit**, apply their corrections and re-display the updated report. Do not proceed to step 5 until the user explicitly accepts the report.

### 5. Optional: Create Jira issue

After the user accepts the report, ask:

```text
Do you want to create this as a Bug in Jira?
```

Offer exactly these two options:

- `Yes` — create the Jira issue
- `No` — I'll paste it manually

If **Yes**:

1. Resolve `cloudId` using `getAccessibleAtlassianResources`. If multiple sites exist, present them and ask the user to pick one.
2. If no project key is known from context, ask for it (e.g. `PROJ`, `QA`, `SCRUM`).
3. Call `createJiraIssue` with:
   - `issueTypeName`: `"Bug"`
   - `summary`: the report title (without the `[Area]` prefix brackets if the tracker already scopes by project)
   - `description`: the full formatted report body (use `contentFormat: "markdown"`)
   - `additional_fields`: `{ "priority": { "name": "<High|Medium|Low>" } }`
4. Return the created issue key and URL exactly as returned by the MCP.

## Hard rules

- Never invent reproduction steps — if the input is too vague, ask.
- Never fabricate environment details — use `Unknown` when they cannot be inferred.
- Preserve all error messages, stack traces, and log lines verbatim in the Logs section.
- Always show and get confirmation on the formatted report before creating a Jira issue.
- Never create a Jira issue without explicit user confirmation.
- If `createJiraIssue` returns an error, surface it exactly — do not guess at the issue URL.
