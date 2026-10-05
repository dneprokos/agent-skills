# SCRUM Bug field reference

Verified against the create metadata for issue type `Bug` (id `10007`) in project
`SCRUM` on `dneprokos-test.atlassian.net`. Re-check with:

```
mcp__atlassian__getJiraIssueTypeMetaWithFields
  cloudId: 66b3ea22-1466-4c68-afca-75d07051091c
  projectIdOrKey: SCRUM
  issueTypeId: 10007
  requiredFieldsOnly: false
```

## Identifiers

| Thing | Value |
|---|---|
| Site | `https://dneprokos-test.atlassian.net` |
| Cloud id | `66b3ea22-1466-4c68-afca-75d07051091c` |
| Project | `SCRUM` — Dneprokos-test-project (team-managed, `next-gen`) |
| Bug issue type id | `10007` |

## Required on create

| Field | Key | Notes |
|---|---|---|
| Project | `project` | |
| Issue Type | `issuetype` | |
| Summary | `summary` | max 255 characters |
| Reporter | `reporter` | defaults to the authenticated account |
| **Defect Detection Phase** | `customfield_10203` | **select, required, defaults to Development** |

### Defect Detection Phase

```json
{ "customfield_10203": { "value": "Production" } }
```

| Value | Option id |
|---|---|
| `Development` | `10020` (the default) |
| `Production` | `10021` |

It has a default, so omitting it does not fail the create — it silently files a
Production bug as Development. Always send it.

## Commonly set

| Field | Key | Shape |
|---|---|---|
| Priority | `priority` | `{ "name": "High" }` — Highest, High, Medium, Low, Lowest; default Medium |
| Labels | `labels` | `["e2e-failure"]` — **no spaces**, Jira rejects them |
| Description | `description` | markdown when `contentFormat: "markdown"` |
| Assignee | `assignee` | account id, not display name |
| Story point estimate | `customfield_10016` | number |
| Sprint | `customfield_10020` | |
| Start date | `customfield_10015` | `YYYY-MM-DD` |
| Flagged | `customfield_10021` | only allowed value is `Impediment` |
| Parent | `parent` | issue key, for placing a bug under an Epic |

Anything without its own parameter on `createJiraIssue` goes in
`additional_fields`.

## The description template

The Bug issue type ships a default description with these headings, which
`assets/bug-description.template.md` mirrors so filed bugs match hand-written
ones:

```
Version:
Initial Condition:
Steps to Reproduce:
Expected Results:
Actual Results:
Affected Tests
```

## Duplicate-search recipes

By distinctive words, the last six months — what the script generates:

```sql
project = SCRUM AND issuetype = Bug AND created >= -180d
  AND (summary ~ "filters genre") ORDER BY created DESC
```

Everything filed from one scan rule:

```sql
project = SCRUM AND issuetype = Bug AND labels = "CM-02"
```

Everything found in production, still open:

```sql
project = SCRUM AND issuetype = Bug
  AND "Defect Detection Phase" = Production AND statusCategory != Done
```

Split by phase, for a defect-containment report:

```sql
project = SCRUM AND issuetype = Bug AND created >= -90d
  ORDER BY "Defect Detection Phase" ASC, priority DESC
```

A custom field can be referenced by name in JQL when the name is unique, or as
`cf[10203]` when it is not.

## Labels in use

| Label | Meaning |
|---|---|
| `e2e-failure`, `automation` | filed from a Playwright run |
| `static-defect-scan` | filed from the static-defect-scan skill |
| `CM-02`, `BV-01`, `SEC-03`, … | the scan rule that found it |
| `contract`, `boundary`, `partition`, `security` | the scan pack |
| `validation`, `security`, `catalogue`, `filtering`, `error-handling`, `performance`, `configuration`, `user-management` | area |

## Reading a created issue back

```
mcp__atlassian__getJiraIssue
  cloudId: 66b3ea22-1466-4c68-afca-75d07051091c
  issueIdOrKey: SCRUM-179
  fields: ["summary", "priority", "labels", "customfield_10203", "description"]
```

`fields: ["*all"]` returns every custom field, which is the quickest way to find
an id this document does not list.
