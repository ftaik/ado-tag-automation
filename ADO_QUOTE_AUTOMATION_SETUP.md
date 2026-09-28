# ADO quote automation v1 setup

This workflow is event-driven using Azure DevOps Service Hooks -> GitHub repository dispatch.

## Files added
- .github/workflows/ado-quote-automation-v1.yml
- scripts/ado-quote-automation.js
- config/ado-quote-automation.config.json
- package.json

## What this automation does
- Handles only work item types: User Story, Request
- Rule 1: Billable transition to Yes can set:
  - Quote Status -> 0 Pending Hours
  - State -> Quote in Progress
- Rule 2: First estimate entry while Quote Status is 0 Pending Hours:
  - Quote Status -> 1 Pending Quote
- Rule 3: Quote Status transition to 1 Pending Quote:
  - Send email to max.peterson@shepherdcmms.com
- Rule 4: Released for Development transition to true:
  - Sends email by area path mapping
  - State -> New

## Secrets required in GitHub repository
Create these in GitHub -> Settings -> Secrets and variables -> Actions -> New repository secret:

- ADO_ORG_URL
  - Example: https://dev.azure.com/shepherdcmms
- ADO_PROJECT
  - Example: Shepherd CMMS
- ADO_PAT
  - Azure DevOps personal access token with Work Items Read/Write scope
- SMTP_HOST
- SMTP_PORT
  - Example: 587
- SMTP_SECURE
  - true for SMTPS, false for STARTTLS on 587
- SMTP_USER
- SMTP_PASS
- SMTP_FROM
  - Example: no-reply@shepherdcmms.com
- TEST_EMAIL_OVERRIDE
  - For test mode, set to: filip@shepherdcmms.com

## Azure DevOps Service Hook setup
In Azure DevOps:

1. Project Settings -> Service hooks -> Create subscription
2. Service: Web Hooks
3. Trigger on event: Work item updated
4. Filters:
   - Team project = Shepherd CMMS
   - Work item type IN User Story, Request
5. URL:
   - POST https://api.github.com/repos/<owner>/<repo>/dispatches
6. HTTP headers:
   - Authorization: Bearer <GITHUB_TOKEN_WITH_REPO_DISPATCH_ACCESS>
   - Accept: application/vnd.github+json
   - X-GitHub-Api-Version: 2022-11-28
   - Content-Type: application/json
7. Body (JSON):

{
  "event_type": "ado-work-item-updated",
  "client_payload": {
    "id": "$(resource.id)",
    "rev": "$(resource.rev)",
    "resource": $(resource)
  }
}

Note: if your Service Hook UI does not support embedding object JSON in body, send id and rev only. The script can run from work item id alone.

## GitHub token for repository dispatch
The service hook call to GitHub needs a token.

Option A: Fine-grained PAT (recommended)
- Resource owner: your org
- Repository access: this repository
- Permissions: Actions write, Contents read/write (or repository dispatch equivalent for your org policy)

Option B: Classic PAT
- Scope: repo

Store this token only in Azure DevOps service hook auth config, not in this repo.

## Manual test
Use workflow dispatch in GitHub Actions:
- workflow: ADO quote automation v1 (event-driven)
- work_item_id: 30458 or 29439
- test_mode: true
- dry_run: true

## Safe test strategy with test tickets
Use this process so tests never email production recipients:

1. Create or choose a test User Story or Request.
2. Add tag `automation-test` on that work item.
3. Run workflow dispatch with:
  - `work_item_id` = your test ticket ID
  - `test_mode` = true
  - `dry_run` = false (real patch + real email send)
4. Verify all emails are delivered only to `TEST_EMAIL_OVERRIDE`.

How this is enforced:
- In `test_mode`, automation skips any ticket missing tag `automation-test`.
- In `test_mode`, all notification recipients are overridden to `TEST_EMAIL_OVERRIDE`.
- Subjects are prefixed with `[TEST MODE]`.

Recommended rollout:
1. First run: `test_mode=true`, `dry_run=true`.
2. Second run: `test_mode=true`, `dry_run=false`.
3. Production run: `test_mode=false`.

Optional event-driven test hook:
- Create a second ADO service hook that sends `client_payload.testMode=true`.
- Keep your production hook unchanged.

## Notes on dedupe behavior
- The workflow triggers on field transitions from the update event, not on static flags.
- This avoids the old issue where IsEmailSent=true blocked future valid notifications.

## Configurable mappings
Edit config/ado-quote-automation.config.json:
- Recipient for quote notifications
- PM recipient by area path
- Estimate fields list
- Allowed work item types
- Required test tag name (`test.requiredTag`)
