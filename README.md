# ADO Automation Workflows

This repository contains GitHub Actions automations for Azure DevOps work items.

## What is in this repo

There are two automation areas:

1. Quote status automation (event-driven)
2. OT-approved tag cleanup workflows (scheduled and manual)

## Quote status automation

Main workflow:

- .github/workflows/ado-quote-automation-v1.yml

Core logic:

- scripts/ado-quote-automation.js
- config/ado-quote-automation.config.json

High-level behavior:

1. Triggered by repository dispatch or manual workflow dispatch.
2. Reads the updated ADO work item and recent updates.
3. Applies rules for User Story and Request work item types.
4. Updates fields/state in ADO when rule conditions are met.
5. Posts ADO comments with proper mentions.

Current rule summary:

1. Billable changed to Yes can set:
   - Quote Status to 0 Pending Hours
   - State to Quote in Progress
2. If Original Estimate or High-level Estimate is entered while Quote Status is 0 Pending Hours:
   - Quote Status is set to 1 Pending Quote
3. When Quote Status transitions to 1 Pending Quote:
   - Quote-ready mention comment is posted
4. When Released for Development transitions to true:
   - PM mention comment is posted based on area mapping
   - State is set to New

Estimate field mapping used by the rules:

1. Microsoft.VSTS.Scheduling.OriginalEstimate
2. Custom.Estimate (used as High-level Estimate in this project)

Test mode summary:

1. Requires automation-test tag.
2. Overrides mention recipient to TEST_EMAIL_OVERRIDE.
3. Supports dry run for validation without changes.

## Azure Functions relay

The ADO Service Hook does not reliably emit the payload shape required by GitHub repository dispatch directly.
Because of that, production flow uses a small Azure Function relay:

1. ADO Service Hook sends work item updated payload to Azure Function.
2. Function transforms payload to repository_dispatch format.
3. Function calls GitHub API to trigger this repository workflow.

Function app settings used by relay:

1. GH_OWNER
2. GH_REPO
3. GH_TOKEN
4. GH_EVENT_TYPE

## OT-approved tag workflows

These are existing maintenance workflows in this repo:

1. .github/workflows/ot-approved-cleanup.yml
   - Scheduled daily and manual
   - Finds iterations that start tomorrow for configured teams
   - Removes configured target tag from work items in those iterations
   - Supports dry run vs apply mode

2. .github/workflows/ot-approved-current-iteration-test.yml
   - Manual test workflow
   - Removes test tag from work items in current iterations for configured teams
   - Supports dry run vs apply mode

## Secrets used by this repo

Quote workflow secrets:

1. ADO_ORG_URL
2. ADO_PROJECT
3. ADO_PAT
4. TEST_EMAIL_OVERRIDE

OT tag workflows secrets:

1. ADO_ORG
2. ADO_PROJECT
3. ADO_TEAMS
4. ADO_PAT
5. TARGET_TAG
6. TIMEZONE_ID

## Notes

1. Comments are marked as automated messages.
2. Mention rendering uses ADO-compatible HTML mention markup.
3. Unknown custom fields are handled defensively so runs do not fail if a field is missing.
- Limit who can edit workflow files.
