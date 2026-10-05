"""Build Slack Block Kit payload for skill-security-check workflow.

Reads env vars set by the workflow, writes JSON to OUTPUT_PATH.
"""

import json
import os

high     = int(os.environ.get("HIGH",    "0"))
medium   = int(os.environ.get("MEDIUM",  "0"))
low      = int(os.environ.get("LOW",     "0"))
checked  = int(os.environ.get("CHECKED", "0"))
findings = os.environ.get("FINDINGS", "").strip()
pr_num   = os.environ.get("PR_NUM", "")
pr_url   = os.environ.get("PR_URL", "")
branch   = os.environ.get("BRANCH", "")
repo     = os.environ.get("REPO", "")
out_path = os.environ.get("OUTPUT_PATH", "/tmp/slack-payload.json")

if high > 0:
    status_icon, status_text = ":red_circle:", "Issues found"
elif medium > 0:
    status_icon, status_text = ":large_yellow_circle:", "Warnings"
else:
    status_icon, status_text = ":large_green_circle:", "All clear"

risk_line = (
    f":red_circle: *{high}* High   "
    f":large_yellow_circle: *{medium}* Medium   "
    f":large_green_circle: *{low}* Low"
)

blocks = [
    {
        "type": "header",
        "text": {"type": "plain_text", "text": f"Skill Security Check — {status_text}"},
    },
    {
        "type": "section",
        "fields": [
            {"type": "mrkdwn", "text": f"*PR:*\n<{pr_url}|#{pr_num}>"},
            {"type": "mrkdwn", "text": f"*Repo:*\n{repo}"},
            {"type": "mrkdwn", "text": f"*Branch:*\n`{branch}`"},
            {"type": "mrkdwn", "text": f"*Items checked:*\n{checked}"},
        ],
    },
    {
        "type": "section",
        "text": {"type": "mrkdwn", "text": f"*Risk summary*\n{risk_line}"},
    },
]

if findings:
    items = "\n".join(f"• {f.strip()}" for f in findings.split("|"))
    blocks.append({
        "type": "section",
        "text": {"type": "mrkdwn", "text": f"*Findings*\n{items}"},
    })

blocks.append({
    "type": "actions",
    "elements": [{
        "type": "button",
        "text": {"type": "plain_text", "text": "View PR"},
        "url": pr_url,
    }],
})

with open(out_path, "w") as f:
    json.dump({"blocks": blocks}, f)

print(f"Slack payload written to {out_path}")
