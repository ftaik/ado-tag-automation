const fs = require("fs");
const path = require("path");

const configPath = path.join(process.cwd(), "config", "ado-quote-automation.config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

function requiredEnv(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return String(value).trim();
}

function compactJsonForLogs(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "<unserializable>";
  }
}

function readEventPayload() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !fs.existsSync(eventPath)) {
    return {};
  }

  const raw = fs.readFileSync(eventPath, "utf8");
  return JSON.parse(raw || "{}");
}

function parseBoolean(value) {
  if (typeof value === "boolean") return value;
  if (value === null || value === undefined) return false;
  const v = String(value).trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

function isEmpty(value) {
  return value === null || value === undefined || String(value).trim() === "";
}

function normalizeString(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function normalizeTagList(tagsValue) {
  if (isEmpty(tagsValue)) return [];
  return String(tagsValue)
    .split(";")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

function normalizeEmail(value) {
  return normalizeString(value).toLowerCase();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isYes(value) {
  const v = normalizeString(value).toLowerCase();
  return v === "yes" || v === "true" || v === "1";
}

function encodeBasicPat(pat) {
  return Buffer.from(`:${pat}`).toString("base64");
}

function extractOrgName(orgUrl) {
  try {
    const parsed = new URL(orgUrl);
    const parts = parsed.pathname.split("/").filter(Boolean);
    return parts.length ? parts[0] : "";
  } catch {
    return "";
  }
}

async function adoRequest({ method, orgUrl, project, pat, endpoint, body, contentType }) {
  const trimmedOrg = orgUrl.replace(/\/+$/, "");
  const encodedProject = encodeURIComponent(project);
  const url = `${trimmedOrg}/${encodedProject}${endpoint}`;

  const headers = {
    Authorization: `Basic ${encodeBasicPat(pat)}`
  };

  if (contentType) {
    headers["Content-Type"] = contentType;
  }

  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`ADO API ${method} ${url} failed: ${response.status} ${response.statusText} - ${text}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

async function adoOrgRequest({ method, orgUrl, pat, endpoint, body, contentType }) {
  const trimmedOrg = orgUrl.replace(/\/+$/, "");
  const url = `${trimmedOrg}${endpoint}`;

  const headers = {
    Authorization: `Basic ${encodeBasicPat(pat)}`
  };

  if (contentType) {
    headers["Content-Type"] = contentType;
  }

  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`ADO API ${method} ${url} failed: ${response.status} ${response.statusText} - ${text}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

async function getWorkItem(orgUrl, project, pat, id, extraFields) {
  const fieldsQuery = Array.from(new Set(extraFields)).join(",");
  return adoRequest({
    method: "GET",
    orgUrl,
    project,
    pat,
    endpoint: `/_apis/wit/workitems/${id}?api-version=7.1&fields=${encodeURIComponent(fieldsQuery)}`
  });
}

function parseUnknownFieldFromAdoError(error) {
  const message = String(error?.message || "");
  const match = message.match(/Cannot find field\s+([^\.]+\.[^\.\"\s]+)\.?/i);
  if (match && match[1]) {
    return match[1].trim();
  }

  // Fallback for quoted variants in ADO error payload text.
  const quotedMatch = message.match(/Cannot find field\s+["']([^"']+)["']/i);
  if (quotedMatch && quotedMatch[1]) {
    return quotedMatch[1].trim();
  }

  return null;
}

async function getWorkItemWithFieldFallback(orgUrl, project, pat, id, extraFields) {
  let candidateFields = Array.from(new Set(extraFields));
  const removedFields = [];

  while (candidateFields.length > 0) {
    try {
      const workItem = await getWorkItem(orgUrl, project, pat, id, candidateFields);
      if (removedFields.length) {
        console.log(`Skipped unknown ADO fields: ${removedFields.join(", ")}`);
      }
      return workItem;
    } catch (error) {
      const unknownField = parseUnknownFieldFromAdoError(error);
      if (!unknownField) {
        throw error;
      }

      const existsInRequest = candidateFields.some(
        (f) => f.toLowerCase() === unknownField.toLowerCase()
      );
      if (!existsInRequest) {
        throw error;
      }

      candidateFields = candidateFields.filter(
        (f) => f.toLowerCase() !== unknownField.toLowerCase()
      );
      removedFields.push(unknownField);
      console.log(`Field not found in ADO and removed from query: ${unknownField}`);
    }
  }

  throw new Error("Unable to fetch work item. All requested fields were removed as unknown.");
}

async function getUpdates(orgUrl, project, pat, id) {
  return adoRequest({
    method: "GET",
    orgUrl,
    project,
    pat,
    endpoint: `/_apis/wit/workitems/${id}/updates?api-version=7.1`
  });
}

async function resolveIdentityByEmail(orgUrl, pat, email) {
  if (isEmpty(email)) return null;

  const filter = encodeURIComponent(String(email).trim());
  const endpoint = `/_apis/identities?searchFilter=General&filterValue=${filter}&queryMembership=None&api-version=7.1`;

  // Try current org host first, then vssps host which often serves identities APIs.
  let result;
  try {
    result = await adoOrgRequest({
      method: "GET",
      orgUrl,
      pat,
      endpoint
    });
  } catch (error) {
    const message = String(error?.message || "").toLowerCase();
    const orgName = extractOrgName(orgUrl);
    const canTryVssps = orgName && (message.includes("401") || message.includes("404"));
    if (!canTryVssps) {
      throw error;
    }

    const vsspsOrgUrl = `https://vssps.dev.azure.com/${orgName}`;
    result = await adoOrgRequest({
      method: "GET",
      orgUrl: vsspsOrgUrl,
      pat,
      endpoint
    });
  }

  const identities = Array.isArray(result?.value) ? result.value : [];
  if (identities.length === 0) {
    return null;
  }

  return identities[0];
}

async function addWorkItemComment(orgUrl, project, pat, id, text) {
  return adoRequest({
    method: "POST",
    orgUrl,
    project,
    pat,
    endpoint: `/_apis/wit/workItems/${id}/comments?api-version=7.1-preview.3`,
    body: { text },
    contentType: "application/json"
  });
}

function tryGetWorkItemId(eventPayload) {
  try {
    return getWorkItemId(eventPayload);
  } catch {
    return null;
  }
}

function isWorkItemNotAccessibleError(error) {
  const message = String(error?.message || "");
  return (
    message.includes("404 Not Found") ||
    message.includes("401 Unauthorized") ||
    message.includes("TF401232") ||
    message.includes("WorkItemUnauthorizedAccessException") ||
    message.includes("does not exist, or you do not have permissions to read it")
  );
}

function extractWorkItemIdFromText(value) {
  const text = normalizeString(value);
  if (!text) return "";

  const patterns = [
    /[?&]id=(\d+)\b/i,
    /\/workitems\/(?:edit\/)?(\d+)\b/i,
    /\b(?:work\s*item|user\s*story|bug|task|request)\s*#(\d+)\b/i,
    /#(\d{3,})\b/
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }

  return "";
}

function resolveVerboseLogging(eventPayload) {
  const cp = eventPayload?.client_payload || {};
  return parseBoolean(process.env.VERBOSE_LOGS) || parseBoolean(cp.verbose_logs) || parseBoolean(cp.debug);
}

function getWorkItemId(eventPayload) {
  const fromInput = normalizeString(process.env.WORK_ITEM_ID);
  if (fromInput) return fromInput;

  const cp = eventPayload.client_payload || {};
  const resource = cp.resource || {};
  const detailedMessage = resource.detailedMessage || {};
  const message = resource.message || {};

  const candidates = [
    { source: "client_payload.resource.workItem.id", value: resource.workItem?.id },
    { source: "client_payload.resource.revision.id", value: resource.revision?.id },
    { source: "client_payload.resource.workItemId", value: resource.workItemId },
    { source: "client_payload.resource.fields.System.Id", value: resource.fields?.["System.Id"] },
    { source: "client_payload.workItemId", value: cp.workItemId },
    { source: "client_payload.work_item_id", value: cp.work_item_id },
    { source: "client_payload.resource.resource.id", value: resource.resource?.id },
    { source: "client_payload.resource.revision.url", value: extractWorkItemIdFromText(resource.revision?.url) },
    { source: "client_payload.resource.url", value: extractWorkItemIdFromText(resource.url) },
    { source: "client_payload.resource.detailedMessage.html", value: extractWorkItemIdFromText(detailedMessage.html) },
    { source: "client_payload.resource.detailedMessage.markdown", value: extractWorkItemIdFromText(detailedMessage.markdown) },
    { source: "client_payload.resource.detailedMessage.text", value: extractWorkItemIdFromText(detailedMessage.text) },
    { source: "client_payload.resource.message.html", value: extractWorkItemIdFromText(message.html) },
    { source: "client_payload.resource.message.markdown", value: extractWorkItemIdFromText(message.markdown) },
    { source: "client_payload.resource.message.text", value: extractWorkItemIdFromText(message.text) }
  ];

  for (const candidate of candidates) {
    if (!isEmpty(candidate.value) && /^\d+$/.test(String(candidate.value).trim())) {
      const resolved = String(candidate.value).trim();
      console.log(`Resolved work item id from ${candidate.source}: ${resolved}`);
      return resolved;
    }
  }

  throw new Error("Could not determine work item ID from workflow input or repository_dispatch payload.");
}

function getRevisionHint(eventPayload) {
  const cp = eventPayload.client_payload || {};
  const resource = cp.resource || {};

  const candidates = [
    cp.rev,
    cp.revision,
    resource.rev,
    resource.revision?.rev,
    resource.resourceVersion,
    resource.revision?.fields?.["System.Rev"]
  ];

  for (const candidate of candidates) {
    if (!isEmpty(candidate) && !Number.isNaN(Number(candidate))) {
      return Number(candidate);
    }
  }

  return null;
}

function pickRelevantUpdate(updates, revisionHint, trackedFields = []) {
  const updateList = Array.isArray(updates?.value) ? updates.value.slice() : [];
  if (updateList.length === 0) {
    return { rev: null, fields: {} };
  }

  if (revisionHint !== null) {
    const exact = updateList.find((u) => Number(u.rev) === Number(revisionHint));
    if (exact) return exact;
  }

  if (revisionHint === null && trackedFields.length) {
    const trackedSet = new Set(trackedFields.map((f) => String(f).toLowerCase()));
    const byNewest = updateList.sort((a, b) => Number(b.rev) - Number(a.rev));
    const firstRuleRelevant = byNewest.find((u) => {
      const names = Object.keys(u?.fields || {}).map((name) => name.toLowerCase());
      return names.some((name) => trackedSet.has(name));
    });

    if (firstRuleRelevant) {
      return firstRuleRelevant;
    }
  }

  updateList.sort((a, b) => Number(a.rev) - Number(b.rev));
  return updateList[updateList.length - 1];
}

function getField(fields, refName) {
  return fields && Object.prototype.hasOwnProperty.call(fields, refName) ? fields[refName] : undefined;
}

function getTransition(update, refName) {
  const field = update?.fields?.[refName];
  if (!field) {
    return { changed: false, oldValue: undefined, newValue: undefined };
  }

  const oldValue = field.oldValue;
  const newValue = field.newValue;
  return {
    changed: true,
    oldValue,
    newValue
  };
}

function patchOp(pathRef, value) {
  return {
    op: "add",
    path: `/fields/${pathRef}`,
    value
  };
}

function shouldHandleWorkItemType(workItemType, allowedTypes) {
  const current = normalizeString(workItemType).toLowerCase();
  return allowedTypes.some((t) => normalizeString(t).toLowerCase() === current);
}

function estimateWasEntered(update, estimateFields) {
  return estimateFields.some((ref) => {
    const transition = getTransition(update, ref);
    if (!transition.changed) return false;
    return isEmpty(transition.oldValue) && !isEmpty(transition.newValue);
  });
}

function hasTag(tagsValue, expectedTag) {
  const tags = normalizeTagList(tagsValue).map((t) => t.toLowerCase());
  return tags.includes(normalizeString(expectedTag).toLowerCase());
}

function resolvePmRecipient(areaPath, pmByAreaPath = {}) {
  const current = normalizeString(areaPath);
  if (!current) return null;

  if (pmByAreaPath[current]) {
    return pmByAreaPath[current];
  }

  // Fallback to nearest configured parent path when area path is deeper than configured mapping.
  const currentLower = current.toLowerCase();
  const candidates = Object.entries(pmByAreaPath)
    .filter(([path]) => currentLower === normalizeString(path).toLowerCase() || currentLower.startsWith(`${normalizeString(path).toLowerCase()}\\`))
    .sort((a, b) => b[0].length - a[0].length);

  return candidates.length ? candidates[0][1] : null;
}

function buildActions({ workItem, update, configObj, testMode }) {
  const refs = configObj.fieldRefs;
  const quoteValues = configObj.quoteStatusValues;
  const stateValues = configObj.stateValues;

  const fields = workItem.fields || {};
  const workItemType = getField(fields, refs.workItemType);
  const areaPath = normalizeString(getField(fields, refs.areaPath));
  const title = normalizeString(getField(fields, refs.title));

  if (!shouldHandleWorkItemType(workItemType, configObj.workItemTypes)) {
    return {
      shouldRun: false,
      reason: `Work item type '${workItemType}' is not configured for automation.`,
      patchOps: [],
      notifications: []
    };
  }

  const requiredTestTag = normalizeString(configObj?.test?.requiredTag);
  if (testMode && requiredTestTag) {
    const tagsValue = getField(fields, refs.tags);
    if (!hasTag(tagsValue, requiredTestTag)) {
      return {
        shouldRun: false,
        reason: `Test mode enabled and required tag '${requiredTestTag}' is missing.`,
        patchOps: [],
        notifications: []
      };
    }
  }

  const patchOps = [];
  const notifications = [];
  let willSetPendingQuote = false;

  const billableTransition = getTransition(update, refs.billable);
  const quoteStatusTransition = getTransition(update, refs.quoteStatus);
  const releasedTransition = getTransition(update, refs.releasedForDevelopment);

  const currentQuoteStatus = normalizeString(getField(fields, refs.quoteStatus));

  if (billableTransition.changed && !isYes(billableTransition.oldValue) && isYes(billableTransition.newValue)) {
    const canMoveToPendingHours = isEmpty(currentQuoteStatus) || /not needed/i.test(currentQuoteStatus);
    if (canMoveToPendingHours) {
      patchOps.push(patchOp(refs.quoteStatus, quoteValues.pendingHours));
      patchOps.push(patchOp(refs.state, stateValues.quoteInProgress));
    }
  }

  if (estimateWasEntered(update, configObj.estimateFields) && currentQuoteStatus === quoteValues.pendingHours) {
    patchOps.push(patchOp(refs.quoteStatus, quoteValues.pendingQuote));
    willSetPendingQuote = true;
  }

  const transitionedToPendingQuote =
    quoteStatusTransition.changed && normalizeString(quoteStatusTransition.newValue) === quoteValues.pendingQuote;

  if (transitionedToPendingQuote || willSetPendingQuote) {
    notifications.push({
      type: "quote-ready",
      to: configObj.emails.quoteReadyTo,
      message: `Work item #${workItem.id} (${title}) changed to '${quoteValues.pendingQuote}'.\nArea: ${areaPath}`
    });
  }

  if (
    releasedTransition.changed &&
    !parseBoolean(releasedTransition.oldValue) &&
    parseBoolean(releasedTransition.newValue)
  ) {
    const pmEmail = resolvePmRecipient(areaPath, configObj?.emails?.pmByAreaPath || {});
    if (pmEmail || testMode) {
      const recipients = pmEmail ? [pmEmail] : ["no-recipient-mapped-in-test-mode@local"];
      notifications.push({
        type: "released-for-development",
        to: recipients,
        message: `Work item #${workItem.id} (${title}) was released for development.\nArea: ${areaPath}`
      });
    } else {
      console.log(`No PM mapping found for area path '${areaPath}'. Skipping released-for-development comment.`);
    }

    patchOps.push(patchOp(refs.state, stateValues.new));
  }

  return {
    shouldRun: true,
    reason: "Processed by configured rules.",
    patchOps,
    notifications
  };
}

async function patchWorkItem(orgUrl, project, pat, id, patchOps) {
  if (!patchOps.length) {
    return null;
  }

  return adoRequest({
    method: "PATCH",
    orgUrl,
    project,
    pat,
    endpoint: `/_apis/wit/workitems/${id}?api-version=7.1`,
    body: patchOps,
    contentType: "application/json-patch+json"
  });
}

function buildWorkItemUrl(orgUrl, project, id) {
  const trimmed = orgUrl.replace(/\/+$/, "");
  const encodedProject = encodeURIComponent(project);
  return `${trimmed}/${encodedProject}/_workitems/edit/${id}`;
}

function resolveDryRun(eventPayload) {
  const fromEnv = process.env.DRY_RUN;
  if (!isEmpty(fromEnv)) {
    return parseBoolean(fromEnv);
  }

  const cp = eventPayload.client_payload || {};
  if (!isEmpty(cp.dryRun)) {
    return parseBoolean(cp.dryRun);
  }

  if (!isEmpty(cp.dry_run)) {
    return parseBoolean(cp.dry_run);
  }

  return false;
}

function resolveTestMode(eventPayload) {
  const fromEnv = process.env.TEST_MODE;
  if (!isEmpty(fromEnv)) {
    return parseBoolean(fromEnv);
  }

  const cp = eventPayload.client_payload || {};
  if (!isEmpty(cp.testMode)) {
    return parseBoolean(cp.testMode);
  }

  if (!isEmpty(cp.test_mode)) {
    return parseBoolean(cp.test_mode);
  }

  return false;
}

function applyTestRecipientOverride(notifications, overrideEmail) {
  if (!notifications.length || isEmpty(overrideEmail)) {
    return notifications;
  }

  return notifications.map((notification) => ({
    ...notification,
    to: [overrideEmail],
    message: `[TEST MODE]\n${notification.message}\nOriginal recipients were overridden to ${overrideEmail}.`
  }));
}

async function addMentionComments({ orgUrl, project, pat, workItemId, workItemUrl, notifications }) {
  if (!notifications.length) {
    return [];
  }

  const results = [];

  for (const notification of notifications) {
    const recipients = Array.isArray(notification.to) ? notification.to : [notification.to];
    for (const recipient of recipients) {
      const email = normalizeString(recipient);
      if (!email) {
        continue;
      }

      const normalizedEmail = normalizeEmail(email);
      let identity = null;
      const mappedId =
        config?.mentions?.identityIdsByEmail?.[normalizedEmail] ||
        config?.mentions?.identityIdsByEmail?.[email];
      const mappedLabel =
        config?.mentions?.labelsByEmail?.[normalizedEmail] ||
        config?.mentions?.labelsByEmail?.[email] ||
        "";

      if (mappedId) {
        identity = { id: mappedId };
      }

      try {
        if (!identity) {
          identity = await resolveIdentityByEmail(orgUrl, pat, email);
        }
      } catch (error) {
        console.log(
          `Identity lookup failed for ${email}. Falling back to plain @email mention text. ${String(error?.message || error)}`
        );
      }

      const mentionId = identity?.id ? String(identity.id) : "";
      const mentionLabel =
        mappedLabel || normalizeString(identity?.displayName) || normalizeString(identity?.uniqueName) || email;
      const mentionMarkup = mentionId
        ? `<a href='#' data-vss-mention='version:2.0,${escapeHtml(mentionId)}'>@${escapeHtml(mentionLabel)}</a>`
        : `@${escapeHtml(email)}`;

      const messageHtml = escapeHtml(notification.message).replace(/\n/g, "<br>");
      const text = `${mentionMarkup}<br>${messageHtml}<br><br><i>This is an automated message.</i>`;
      const comment = await addWorkItemComment(orgUrl, project, pat, workItemId, text);

      results.push({
        type: notification.type,
        recipient: email,
        commentId: comment?.id ?? null,
        identityResolved: Boolean(identity?.id)
      });
    }
  }

  return results;
}

async function main() {
  const orgUrl = requiredEnv("ADO_ORG_URL");
  const project = requiredEnv("ADO_PROJECT");
  const pat = requiredEnv("ADO_PAT");

  const eventPayload = readEventPayload();
  const verboseLogging = resolveVerboseLogging(eventPayload);
  const discoveredWorkItemId = tryGetWorkItemId(eventPayload);
  console.log(`Event candidate work item id: ${discoveredWorkItemId || "<none>"}`);
  if (verboseLogging) {
    console.log(`Event payload preview: ${compactJsonForLogs(eventPayload?.client_payload || {})}`);
  } else {
    console.log("Event payload preview: <omitted; set VERBOSE_LOGS=true to print full payload>");
  }

  const workItemId = getWorkItemId(eventPayload);
  const revisionHint = getRevisionHint(eventPayload);
  const dryRun = resolveDryRun(eventPayload);
  const testMode = resolveTestMode(eventPayload);
  const testEmailOverride = normalizeString(process.env.TEST_EMAIL_OVERRIDE);

  const fieldsToFetch = [
    config.fieldRefs.workItemType,
    config.fieldRefs.areaPath,
    config.fieldRefs.title,
    config.fieldRefs.state,
    config.fieldRefs.tags,
    config.fieldRefs.billable,
    config.fieldRefs.quoteStatus,
    config.fieldRefs.releasedForDevelopment,
    config.fieldRefs.isEmailSent,
    config.fieldRefs.isPmEmailSent,
    ...config.estimateFields
  ];

  console.log(`Processing work item ${workItemId}`);
  console.log(`Dry run: ${dryRun}`);
  console.log(`Test mode: ${testMode}`);
  if (testMode) {
    console.log(`Test recipient override: ${testEmailOverride || "not set"}`);
  }
  if (revisionHint !== null) {
    console.log(`Revision hint from event payload: ${revisionHint}`);
  }

  const trackedFields = [
    config.fieldRefs.billable,
    config.fieldRefs.quoteStatus,
    config.fieldRefs.releasedForDevelopment,
    ...config.estimateFields
  ];

  let workItem;
  let updates;
  try {
    workItem = await getWorkItemWithFieldFallback(orgUrl, project, pat, workItemId, fieldsToFetch);
    updates = await getUpdates(orgUrl, project, pat, workItemId);
  } catch (error) {
    if (isWorkItemNotAccessibleError(error)) {
      console.log("EXIT STATUS: SKIPPED_INACCESSIBLE_WORK_ITEM");
      console.log(`Skipping work item ${workItemId}: inaccessible, deleted, or outside permissions.`);
      console.log(String(error?.message || error));
      return;
    }
    throw error;
  }
  const relevantUpdate = pickRelevantUpdate(updates, revisionHint, trackedFields);

  console.log(`Using update revision: ${relevantUpdate.rev ?? "unknown"}`);

  const actions = buildActions({
    workItem,
    update: relevantUpdate,
    configObj: config,
    testMode
  });

  if (!actions.shouldRun) {
    console.log("RUN STATUS: NO_TRIGGER_MATCH");
    console.log("EXIT STATUS: SKIPPED_NO_TRIGGER");
    console.log(actions.reason);
    return;
  }

  console.log("RUN STATUS: TRIGGER_MATCHED");

  const workItemUrl = buildWorkItemUrl(orgUrl, project, workItemId);

  console.log(`Patch operations: ${actions.patchOps.length}`);
  if (actions.patchOps.length) {
    console.log(JSON.stringify(actions.patchOps, null, 2));
  }

  const notificationsToSend = testMode
    ? applyTestRecipientOverride(actions.notifications, testEmailOverride)
    : actions.notifications;

  console.log(`Notifications: ${notificationsToSend.length}`);
  if (notificationsToSend.length) {
    console.log(
      JSON.stringify(
        notificationsToSend.map((n) => ({ type: n.type, to: n.to, message: n.message })),
        null,
        2
      )
    );
  }

  if (!dryRun) {
    if (actions.patchOps.length) {
      await patchWorkItem(orgUrl, project, pat, workItemId, actions.patchOps);
      console.log("Work item patch applied.");
    }

    if (notificationsToSend.length) {
      const comments = await addMentionComments({
        orgUrl,
        project,
        pat,
        workItemId,
        workItemUrl,
        notifications: notificationsToSend
      });
      console.log("Mention comments added:");
      console.log(JSON.stringify(comments, null, 2));
    }
  } else {
    console.log("Dry run enabled. No patch and no mention comments were executed.");
  }

  console.log("EXIT STATUS: EXECUTED");
  console.log(`Done. Work item URL: ${workItemUrl}`);
}

main().catch((error) => {
  console.error("Automation run failed.");
  console.error(error);
  process.exit(1);
});
