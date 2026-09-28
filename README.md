# ADO Quote Automation - Event-Driven GitHub Actions

This repository contains an event-driven GitHub Actions pipeline that automates Azure DevOps work item behavior for quote workflow changes.

The pipeline is designed to:
- React to ADO work item update events (no polling loop)
- Apply field/state updates based on transitions
- Add ADO comments that tag relevant users instead of sending emails
- Support a safe test mode that limits execution to tagged test tickets and redirects all mentions to one user

## High-Level Flow

1. ADO Service Hook fires on work item update.
2. Service Hook calls GitHub repository dispatch API.
3. GitHub Action workflow starts.
4. Node script loads work item details and update history from ADO.
5. Script finds the relevant revision/update and evaluates transition rules.
6. Script applies ADO field patches (if needed).
7. Script posts ADO comments that tag intended recipients.

## Pipeline Files

- `.github/workflows/ado-quote-automation-v1.yml`
  - GitHub Actions workflow entry point
  - Supports both `repository_dispatch` and manual `workflow_dispatch`
- `scripts/ado-quote-automation.js`
  - Rule engine and ADO API client logic
  - Handles patch operations and mention comment creation
- `config/ado-quote-automation.config.json`
  - Rule configuration (fields, statuses, recipients, test tag)
- `package.json`
  - Node project metadata and script command

## Triggers

### Production Trigger
- Event: `repository_dispatch`
- Type: `ado-work-item-updated`

### Manual Trigger
- Event: `workflow_dispatch`
- Inputs:
  - `work_item_id` (required)
  - `test_mode` (boolean)
  - `dry_run` (boolean)

## Rule Engine Behavior

The automation only processes work item types configured in `config/ado-quote-automation.config.json`:
- User Story
- Request

### Rule 1: Billable -> Yes transition
When `Custom.Billable` changes from not-yes to yes:
- Set `Custom.QuoteStatus` to `0 Pending Hours` if current status is empty or matches `*Not Needed*`
- Set `System.State` to `Quote in Progress`

### Rule 2: First estimate entry while status is 0 Pending Hours
When any configured estimate field transitions from empty to non-empty, and current quote status is `0 Pending Hours`:
- Set `Custom.QuoteStatus` to `1 Pending Quote`

Configured estimate fields:
- `Microsoft.VSTS.Scheduling.OriginalEstimate`
- `Custom.PMEstimate`
- `Custom.DesignEstimate`
- `Custom.High-levelEstimate`

### Rule 3: Quote Status transition to 1 Pending Quote
When `Custom.QuoteStatus` transitions to `1 Pending Quote`:
- Add ADO comment tagging configured quote recipient

### Rule 4: Released for Development transition to true
When `Custom.ReleasedforDevelopment` transitions false -> true:
- Add ADO comment tagging PM mapped by `System.AreaPath`
- Set `System.State` to `New`

## Mention Notifications (No SMTP)

This implementation does not send SMTP email.

Instead, for each notification target:
1. Script resolves identity by email using ADO identities API.
2. Script posts a work item comment with mention token when identity is found.
3. If identity lookup fails, script falls back to plain `@email` text in comment body.

## Test Mode Design

Test mode is intended for safe validation on real tickets.

When `test_mode=true`:
- Ticket must include tag `automation-test` (configurable via `test.requiredTag`)
- All mention targets are overridden to `TEST_EMAIL_OVERRIDE`
- Comment text is prefixed with `[TEST MODE]`

This prevents production users from being tagged during testing.

## Required GitHub Secrets

Set these in GitHub repository settings:

- `ADO_ORG_URL`
  - Example: `https://dev.azure.com/shepherdcmms`
- `ADO_PROJECT`
  - Example: `Shepherd CMMS`
- `ADO_PAT`
  - PAT scope: Work Items Read + Write
- `TEST_EMAIL_OVERRIDE`
  - Example: `filip@shepherdcmms.com`

Notes:
- Old SMTP secrets are not used by this version.
- Existing unrelated secrets can remain.

## Azure DevOps Service Hook Setup

Create a Service Hook subscription in ADO:

1. Project Settings -> Service hooks -> Create subscription
2. Service: Web Hooks
3. Trigger: Work item updated
4. Filters:
   - Team project = Shepherd CMMS
   - Work item type in User Story, Request
5. Request URL:
   - `https://api.github.com/repos/<owner>/<repo>/dispatches`
6. Headers:
   - `Authorization: Bearer <GITHUB_TOKEN_WITH_REPO_DISPATCH_ACCESS>`
   - `Accept: application/vnd.github+json`
   - `X-GitHub-Api-Version: 2022-11-28`
   - `Content-Type: application/json`
7. Body:

```json
{
  "event_type": "ado-work-item-updated",
  "client_payload": {
    "id": "$(resource.id)",
    "rev": "$(resource.rev)",
    "resource": $(resource)
  }
}
```

If the Service Hook body editor cannot embed object JSON for `resource`, sending `id` and `rev` is still sufficient.

## Manual Test Procedure

1. Pick a test User Story or Request.
2. Add tag `automation-test`.
3. Run workflow manually with:
   - `work_item_id=<ticket id>`
   - `test_mode=true`
   - `dry_run=true`
4. Check logs for proposed patch ops and comments.
5. Re-run with `dry_run=false` to execute real patch/comment actions.

## Production Rollout Procedure

1. Validate multiple test scenarios in `test_mode=true`.
2. Verify comments only tag `TEST_EMAIL_OVERRIDE` user in test mode.
3. Run with `test_mode=false` when ready.
4. Monitor Actions logs and work item comments for first live updates.

## Failure Handling and Observability

The script fails fast when:
- Required env vars are missing
- ADO API calls return non-success responses
- Work item ID cannot be determined

Logs include:
- Work item ID
- Dry run and test mode state
- Selected update revision
- Patch operation list
- Notification intent list
- Mention comment results

## Configuration Reference

All behavior is controlled in `config/ado-quote-automation.config.json`:
- Allowed work item types
- Field reference names
- Estimate fields
- Quote status/state target values
- Recipient mappings
- Test tag requirement

## Local Development Notes

Install dependencies:

```bash
npm install
```

Run script manually (with env vars populated):

```bash
node scripts/ado-quote-automation.js
```

The script expects to run inside GitHub Actions for event payload handling, but can be run locally for API-level debugging.

## Current Recipient Mapping

Quote status notifications:
- `max.peterson@shepherdcmms.com`

Released for development by area path:
- `Shepherd CMMS\\CSO Completion` -> `max@shepherdcmms.com`
- `Shepherd CMMS\\Modules` -> `max@shepherdcmms.com`
- `Shepherd CMMS\\CSO Origination` -> `harout@shepherdcmms.com`
- `Shepherd CMMS\\CSO Post Processing` -> `harout@shepherdcmms.com`

## Security Notes

- Keep PAT tokens only in secrets (never in code).
- Prefer least-privilege PAT scopes.
- Rotate PATs regularly.
- Limit who can edit workflow files.
