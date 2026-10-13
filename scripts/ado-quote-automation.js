const fs = require("fs");
const path = require("path");

const configPath = path.join(process.cwd(), "config", "ado-quote-automation.config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const AUTOMATION_KEY_PREFIX = "automation-key:";

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

async function getUpdateById(orgUrl, project, pat, id, updateId) {
  return adoRequest({
    method: "GET",
    orgUrl,
    project,
    pat,
    endpoint: `/_apis/wit/workitems/${id}/updates/${updateId}?api-version=7.1`
  });
}

function buildUpdatesByRevisionMap(updatesResponse) {
  const updateList = Array.isArray(updatesResponse?.value) ? updatesResponse.value : [];
  const map = new Map();

  for (const update of updateList) {
    const rev = parsePositiveInteger(update?.rev);
    if (rev === null) {
      continue;
    }

    if (!map.has(rev)) {
      map.set(rev, update);
    }
  }

  return map;
}

function getUpdateByRevision(updatesByRevision, revision) {
  const normalizedRevision = parsePositiveInteger(revision);
  if (normalizedRevision === null) {
    return null;
  }

  return updatesByRevision.get(normalizedRevision) || null;
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

async function getRecentWorkItemComments(orgUrl, project, pat, id, top = 200) {
  return adoRequest({
    method: "GET",
    orgUrl,
    project,
    pat,
    endpoint: `/_apis/wit/workItems/${id}/comments?$top=${top}&order=desc&api-version=7.1-preview.3`
  });
}

function tryGetWorkItemId(eventPayload) {
  try {
    return getWorkItemId(eventPayload, { logResolution: false });
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

function parsePositiveInteger(value) {
  if (isEmpty(value)) return null;
  const normalized = String(value).trim();
  if (!/^\d+$/.test(normalized)) return null;
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function normalizeChangedFieldNames(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => normalizeString(v))
    .filter((v) => v.length > 0);
}

function getChangedFieldNames(update) {
  return Object.keys(update?.fields || {});
}

function getTrackedFieldsChanged(update, trackedFields = []) {
  const tracked = new Set(trackedFields.map((f) => normalizeString(f).toLowerCase()));
  return getChangedFieldNames(update).filter((field) => tracked.has(normalizeString(field).toLowerCase()));
}

function getWorkItemId(eventPayload, options = {}) {
  const { logResolution = true } = options;
  const fromInput = normalizeString(process.env.WORK_ITEM_ID);
  if (fromInput) return fromInput;

  const cp = eventPayload.client_payload || {};
  const resource = cp.resource || {};
  const detailedMessage = resource.detailedMessage || {};
  const message = resource.message || {};

  const highConfidenceCandidates = [
    { source: "client_payload.resource.revision.url", value: extractWorkItemIdFromText(resource.revision?.url) },
    { source: "client_payload.resource.url", value: extractWorkItemIdFromText(resource.url) },
    { source: "client_payload.resource.detailedMessage.html", value: extractWorkItemIdFromText(detailedMessage.html) },
    { source: "client_payload.resource.detailedMessage.markdown", value: extractWorkItemIdFromText(detailedMessage.markdown) },
    { source: "client_payload.resource.detailedMessage.text", value: extractWorkItemIdFromText(detailedMessage.text) },
    { source: "client_payload.resource.message.html", value: extractWorkItemIdFromText(message.html) },
    { source: "client_payload.resource.message.markdown", value: extractWorkItemIdFromText(message.markdown) },
    { source: "client_payload.resource.message.text", value: extractWorkItemIdFromText(message.text) }
  ];

  const candidates = [
    ...highConfidenceCandidates,
    { source: "client_payload.resource.workItem.id", value: resource.workItem?.id },
    { source: "client_payload.resource.revision.id", value: resource.revision?.id },
    { source: "client_payload.resource.workItemId", value: resource.workItemId },
    { source: "client_payload.resource.fields.System.Id", value: resource.fields?.["System.Id"] },
    { source: "client_payload.workItemId", value: cp.workItemId },
    { source: "client_payload.work_item_id", value: cp.work_item_id }
  ];

  for (const candidate of candidates) {
    if (!isEmpty(candidate.value) && /^\d+$/.test(String(candidate.value).trim())) {
      const resolved = String(candidate.value).trim();
      if (logResolution) {
        console.log(`Resolved work item id from ${candidate.source}: ${resolved}`);
      }
      return resolved;
    }
  }

  throw new Error("Could not determine work item ID from workflow input or repository_dispatch payload.");
}

function getRevisionHint(eventPayload, options = {}) {
  const { strictDispatchContract = false } = options;
  const cp = eventPayload.client_payload || {};
  const resource = cp.resource || {};

  const contractRevision = parsePositiveInteger(cp.revision_hint);
  if (contractRevision !== null) {
    console.log(`Resolved revision hint from client_payload.revision_hint: ${contractRevision}`);
    return contractRevision;
  }

  if (strictDispatchContract) {
    return null;
  }

  const candidates = [
    { source: "client_payload.resource.rev", value: resource.rev },
    { source: "client_payload.resource.revision.rev", value: resource.revision?.rev },
    { source: "client_payload.resource.revision.fields.System.Rev", value: resource.revision?.fields?.["System.Rev"] },
    { source: "client_payload.revision_hint", value: cp.revision_hint }
  ];

  for (const candidate of candidates) {
    const revision = parsePositiveInteger(candidate.value);
    if (revision !== null) {
      console.log(`Resolved revision hint from ${candidate.source}: ${revision}`);
      return revision;
    }
  }

  return null;
}

function pickRelevantUpdate(updates, revisionHint) {
  const updateList = Array.isArray(updates?.value) ? updates.value.slice() : [];
  if (updateList.length === 0) {
    return null;
  }

  if (revisionHint !== null) {
    const exact = updateList.find((u) => Number(u.rev) === Number(revisionHint));
    if (exact) return exact;
    return null;
  }

  updateList.sort((a, b) => Number(a.rev) - Number(b.rev));
  return updateList[updateList.length - 1];
}

function updateTouchesTrackedFields(update, trackedFields = []) {
  const changedFields = Object.keys(update?.fields || {}).map((f) => String(f).toLowerCase());
  const tracked = new Set(trackedFields.map((f) => String(f).toLowerCase()));
  return changedFields.some((f) => tracked.has(f));
}

function analyzeStaleRevisionConflictFromUpdates({
  revisionHint,
  currentRevision,
  trackedFields,
  maxScan,
  updatesByRevision
}) {
  const gap = currentRevision - revisionHint;
  if (gap <= 0) {
    return { canProcess: true, reason: "not-stale", conflicts: [] };
  }

  if (gap > maxScan) {
    return {
      canProcess: false,
      reason: "stale-scan-limit",
      conflicts: [],
      scanned: 0,
      gap,
      maxScan
    };
  }

  const conflicts = [];
  for (let rev = revisionHint + 1; rev <= currentRevision; rev += 1) {
    const update = updatesByRevision.get(rev);
    if (!update) {
      continue;
    }
    if (updateTouchesTrackedFields(update, trackedFields)) {
      conflicts.push({
        rev,
        revisedBy: normalizeEmail(update?.revisedBy?.uniqueName || update?.revisedBy?.name || "") || "<unknown>"
      });
    }
  }

  return {
    canProcess: conflicts.length === 0,
    reason: conflicts.length ? "stale-tracked-field-conflict" : "stale-no-conflict",
    conflicts,
    scanned: gap,
    gap,
    maxScan
  };
}

async function analyzeStaleRevisionConflict({
  orgUrl,
  project,
  pat,
  workItemId,
  revisionHint,
  currentRevision,
  trackedFields,
  maxScan
}) {
  const updatesResponse = await getUpdates(orgUrl, project, pat, workItemId);
  const updatesByRevision = buildUpdatesByRevisionMap(updatesResponse);

  return analyzeStaleRevisionConflictFromUpdates({
    revisionHint,
    currentRevision,
    trackedFields,
    maxScan,
    updatesByRevision
  });
}

function resolveAutomationActors() {
  const configured = normalizeString(process.env.AUTOMATION_ACTORS);
  const defaults = ["dev@shepherd.build", "app@shepherd"];
  if (!configured) {
    return new Set(defaults.map((v) => v.toLowerCase()));
  }

  const values = configured
    .split(",")
    .map((v) => normalizeString(v).toLowerCase())
    .filter((v) => v.length > 0);

  return new Set(values.length ? values : defaults.map((v) => v.toLowerCase()));
}

function parseNullableBoolean(value) {
  if (typeof value === "boolean") return value;
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes"].includes(normalized)) return true;
  if (["false", "0", "no"].includes(normalized)) return false;
  return null;
}

function stringifyFieldValueForLogs(value, maxLength = 220) {
  if (value === null || value === undefined) return "<empty>";

  let raw;
  if (typeof value === "string") {
    raw = value;
  } else {
    try {
      raw = JSON.stringify(value);
    } catch {
      raw = String(value);
    }
  }

  const compact = String(raw).replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }

  return `${compact.slice(0, maxLength)}...`;
}

function logRevisionChangeDetails(update) {
  const changedEntries = Object.entries(update?.fields || {});
  const changedFieldNames = changedEntries.map(([name]) => name);
  const revisedBy = normalizeString(update?.revisedBy?.uniqueName || update?.revisedBy?.name || "<unknown>");
  const revisedDate = normalizeString(update?.revisedDate || "<unknown>");

  console.log(`Revision metadata: rev=${update?.rev ?? "unknown"}, revisedBy=${revisedBy}, revisedDate=${revisedDate}`);
  console.log(`Revision changed field count: ${changedFieldNames.length}`);
  console.log(`Revision changed fields: ${changedFieldNames.length ? changedFieldNames.join(", ") : "<none>"}`);

  if (!changedEntries.length) {
    return;
  }

  const details = changedEntries.map(([fieldName, delta]) => ({
    field: fieldName,
    oldValue: stringifyFieldValueForLogs(delta?.oldValue),
    newValue: stringifyFieldValueForLogs(delta?.newValue)
  }));

  console.log("Revision field transitions:");
  console.log(JSON.stringify(details, null, 2));
}

function areFieldValuesEquivalent(currentValue, nextValue) {
  const currentBool = parseNullableBoolean(currentValue);
  const nextBool = parseNullableBoolean(nextValue);
  if (currentBool !== null && nextBool !== null) {
    return currentBool === nextBool;
  }

  const currentNumber = Number(currentValue);
  const nextNumber = Number(nextValue);
  if (!Number.isNaN(currentNumber) && !Number.isNaN(nextNumber)) {
    return currentNumber === nextNumber;
  }

  return normalizeString(currentValue) === normalizeString(nextValue);
}

function filterNoopPatchOps(patchOps, fields) {
  const effective = [];
  for (const op of patchOps) {
    const fieldRef = normalizeString(op?.path || "").replace(/^\/fields\//i, "");
    if (!fieldRef) {
      effective.push(op);
      continue;
    }

    const currentValue = getField(fields, fieldRef);
    if (areFieldValuesEquivalent(currentValue, op.value)) {
      continue;
    }

    effective.push(op);
  }

  return effective;
}

function buildRuleOperationKey({ workItemId, triggerRevision, ruleName }) {
  const revisionPart = parsePositiveInteger(triggerRevision) || "manual";
  const normalizedRuleName = normalizeString(ruleName).toLowerCase().replace(/[^a-z0-9._:-]/g, "-");
  return `${workItemId}:${revisionPart}:${normalizedRuleName}`;
}

function buildNotificationAutomationKey({ workItemId, triggerRevision, notificationType, recipient }) {
  const revisionPart = parsePositiveInteger(triggerRevision) || "manual";
  const typePart = normalizeString(notificationType).toLowerCase().replace(/\s+/g, "-");
  const recipientPart = normalizeEmail(recipient).replace(/[^a-z0-9._@-]/g, "");
  return `${workItemId}:${revisionPart}:${typePart}:${recipientPart}`;
}

function extractAutomationKeys(text) {
  const keys = [];
  const raw = String(text || "");
  const regex = /automation-key:([a-z0-9:._@-]+)/gi;
  let match;
  while ((match = regex.exec(raw)) !== null) {
    if (match[1]) {
      keys.push(match[1].toLowerCase());
    }
  }
  return keys;
}

function extractOperationKeys(text) {
  const keys = [];
  const raw = String(text || "");
  const regex = /operation-key:([a-z0-9:._@-]+)/gi;
  let match;
  while ((match = regex.exec(raw)) !== null) {
    if (match[1]) {
      keys.push(match[1].toLowerCase());
    }
  }
  return keys;
}

function toAdoPatchOps(patchOps) {
  return patchOps.map((op) => ({
    op: op.op,
    path: op.path,
    value: op.value
  }));
}

function logCompactSummary({
  runStatus,
  exitStatus,
  workItemId,
  triggerRevision,
  currentRevision,
  revisedBy,
  trackedFieldsChanged,
  rulesFired,
  actionKeys
}) {
  const tracked = Array.isArray(trackedFieldsChanged) && trackedFieldsChanged.length ? trackedFieldsChanged.join("|") : "none";
  const rules = Array.isArray(rulesFired) && rulesFired.length ? rulesFired.join("|") : "none";
  const keys = Array.isArray(actionKeys) && actionKeys.length ? actionKeys.join("|") : "none";
  const summary = [
    `wi=${workItemId || "unknown"}`,
    `triggerRev=${triggerRevision ?? "na"}`,
    `currentRev=${currentRevision ?? "na"}`,
    `revisedBy=${revisedBy || "unknown"}`,
    `tracked=${tracked}`,
    `rules=${rules}`,
    `actionKeys=${keys}`,
    `run=${runStatus || "unknown"}`,
    `exit=${exitStatus || "unknown"}`
  ].join(" ");
  console.log(`RUN SUMMARY: ${summary}`);
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

function patchOp(pathRef, value, ruleName = "") {
  const op = {
    op: "add",
    path: `/fields/${pathRef}`,
    value
  };

  if (ruleName) {
    op.ruleName = ruleName;
  }

  return op;
}

function makeNotification(type, to, message, ruleName = "") {
  return {
    type,
    to,
    message,
    ruleName
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
  const RULES = {
    BILLABLE_TO_PENDING_HOURS: "billable-to-pending-hours",
    ESTIMATE_TO_PENDING_QUOTE: "estimate-to-pending-quote",
    PENDING_QUOTE_NOTIFICATION: "pending-quote-notification",
    RELEASED_FOR_DEV: "released-for-development"
  };

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
      patchOps.push(patchOp(refs.quoteStatus, quoteValues.pendingHours, RULES.BILLABLE_TO_PENDING_HOURS));
      patchOps.push(patchOp(refs.state, stateValues.quoteInProgress, RULES.BILLABLE_TO_PENDING_HOURS));
    }
  }

  if (estimateWasEntered(update, configObj.estimateFields) && currentQuoteStatus === quoteValues.pendingHours) {
    patchOps.push(patchOp(refs.quoteStatus, quoteValues.pendingQuote, RULES.ESTIMATE_TO_PENDING_QUOTE));
    willSetPendingQuote = true;
  }

  const transitionedToPendingQuote =
    quoteStatusTransition.changed && normalizeString(quoteStatusTransition.newValue) === quoteValues.pendingQuote;

  if (transitionedToPendingQuote || willSetPendingQuote) {
    notifications.push(
      makeNotification(
        "quote-ready",
        configObj.emails.quoteReadyTo,
        `Work item #${workItem.id} (${title}) changed to '${quoteValues.pendingQuote}'.\nArea: ${areaPath}`,
        RULES.PENDING_QUOTE_NOTIFICATION
      )
    );
  }

  if (
    releasedTransition.changed &&
    !parseBoolean(releasedTransition.oldValue) &&
    parseBoolean(releasedTransition.newValue)
  ) {
    const pmEmail = resolvePmRecipient(areaPath, configObj?.emails?.pmByAreaPath || {});
    if (pmEmail || testMode) {
      const recipients = pmEmail ? [pmEmail] : ["no-recipient-mapped-in-test-mode@local"];
      notifications.push(
        makeNotification(
          "released-for-development",
          recipients,
          `Work item #${workItem.id} (${title}) was released for development.\nArea: ${areaPath}`,
          RULES.RELEASED_FOR_DEV
        )
      );
    } else {
      console.log(`No PM mapping found for area path '${areaPath}'. Skipping released-for-development comment.`);
    }

    patchOps.push(patchOp(refs.state, stateValues.new, RULES.RELEASED_FOR_DEV));
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

async function addMentionComments({
  orgUrl,
  project,
  pat,
  workItemId,
  workItemUrl,
  notifications,
  triggerRevision,
  existingCommentItems = null,
  operationKeysByRule = new Map()
}) {
  if (!notifications.length) {
    return [];
  }

  const results = [];
  let commentItems = existingCommentItems;
  if (!Array.isArray(commentItems)) {
    const existingComments = await getRecentWorkItemComments(orgUrl, project, pat, workItemId, 200);
    commentItems = Array.isArray(existingComments?.comments)
      ? existingComments.comments
      : Array.isArray(existingComments?.value)
        ? existingComments.value
        : [];
  }

  const resolvedCommentItems = Array.isArray(commentItems)
    ? commentItems
    : Array.isArray(commentItems?.comments)
      ? commentItems.comments
      : Array.isArray(commentItems?.value)
        ? commentItems.value
        : [];

  const seenKeys = new Set();
  for (const comment of resolvedCommentItems) {
    for (const key of extractAutomationKeys(comment?.text)) {
      seenKeys.add(key);
    }
  }

  for (const notification of notifications) {
    const recipients = Array.isArray(notification.to) ? notification.to : [notification.to];
    for (const recipient of recipients) {
      const email = normalizeString(recipient);
      if (!email) {
        continue;
      }

      const automationKey = buildNotificationAutomationKey({
        workItemId,
        triggerRevision,
        notificationType: notification.type,
        recipient: email
      });

      const notificationRuleName = normalizeString(notification.ruleName) || normalizeString(notification.type);
      const operationKey =
        operationKeysByRule.get(notificationRuleName) ||
        buildRuleOperationKey({
          workItemId,
          triggerRevision,
          ruleName: notificationRuleName || "notification"
        });

      if (seenKeys.has(automationKey.toLowerCase())) {
        results.push({
          type: notification.type,
          recipient: email,
          commentId: null,
          identityResolved: false,
          skipped: true,
          reason: "duplicate-automation-key"
        });
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
      const text = `${mentionMarkup}<br>${messageHtml}<br><br><i>This is an automated message.</i><br><code>operation-key:${escapeHtml(operationKey)}</code><br><code>${AUTOMATION_KEY_PREFIX}${escapeHtml(automationKey)}</code>`;
      const comment = await addWorkItemComment(orgUrl, project, pat, workItemId, text);
      seenKeys.add(automationKey.toLowerCase());

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
  const eventName = normalizeString(process.env.GITHUB_EVENT_NAME).toLowerCase();
  const isManualDispatch = eventName === "workflow_dispatch";
  const automationActors = resolveAutomationActors();
  const verboseLogging = resolveVerboseLogging(eventPayload);
  const runtimeSha = normalizeString(process.env.GITHUB_SHA);
  const runtimeShaShort = runtimeSha ? runtimeSha.slice(0, 7) : "local";
  console.log(`Runtime version (GITHUB_SHA): ${runtimeShaShort}`);
  const discoveredWorkItemId = tryGetWorkItemId(eventPayload);
  console.log(`Event candidate work item id: ${discoveredWorkItemId || "<none>"}`);
  if (verboseLogging) {
    console.log(`Event payload preview: ${compactJsonForLogs(eventPayload?.client_payload || {})}`);
  } else {
    console.log("Event payload preview: <omitted; set VERBOSE_LOGS=true to print full payload>");
  }

  const cp = eventPayload.client_payload || {};
  const workItemId = getWorkItemId(eventPayload);
  const revisionHint = getRevisionHint(eventPayload, { strictDispatchContract: !isManualDispatch });
  const dryRun = resolveDryRun(eventPayload);
  const testMode = resolveTestMode(eventPayload);
  const testEmailOverride = normalizeString(process.env.TEST_EMAIL_OVERRIDE);
  const contractEventId = normalizeString(cp.eventId || cp.event_id || "");
  const contractRevisedBy =
    normalizeString(cp.revisedBy?.uniqueName || cp.revisedBy?.name || cp.revisedBy?.displayName || "") || "<unknown>";
  const contractChangedFieldNames = normalizeChangedFieldNames(cp.changedFieldNames);

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

  const staleScanLimit = parsePositiveInteger(process.env.MAX_STALE_REV_SCAN) || 40;

  let workItem;
  let relevantUpdate;
  let currentRevision = null;
  let updatesByRevision = null;
  const runSummary = {
    workItemId,
    triggerRevision: revisionHint,
    currentRevision: null,
    revisedBy: contractRevisedBy,
    trackedFieldsChanged: contractChangedFieldNames,
    rulesFired: [],
    actionKeys: []
  };
  const emitSummary = (runStatus, exitStatus, overrides = {}) => {
    logCompactSummary({
      ...runSummary,
      ...overrides,
      runStatus,
      exitStatus
    });
  };

  if (!isManualDispatch && revisionHint === null) {
    console.log("RUN STATUS: REVISION_GUARD");
    console.log("EXIT STATUS: SKIPPED_MISSING_REVISION_HINT");
    console.log("Missing revision_hint in repository_dispatch payload. Skipping to enforce strict event contract.");
    emitSummary("REVISION_GUARD", "SKIPPED_MISSING_REVISION_HINT");
    return;
  }

  if (!isEmpty(contractEventId)) {
    console.log(`Event id from relay payload: ${contractEventId}`);
  }
  try {
    workItem = await getWorkItemWithFieldFallback(orgUrl, project, pat, workItemId, fieldsToFetch);
    currentRevision = parsePositiveInteger(workItem?.rev);
    runSummary.currentRevision = currentRevision;
    const updatesResponse = await getUpdates(orgUrl, project, pat, workItemId);
    updatesByRevision = buildUpdatesByRevisionMap(updatesResponse);

    if (revisionHint !== null) {
      if (currentRevision !== null && revisionHint > currentRevision) {
        console.log("RUN STATUS: REVISION_GUARD");
        console.log("EXIT STATUS: SKIPPED_INVALID_REVISION_HINT");
        console.log(`Revision hint ${revisionHint} is ahead of current revision ${currentRevision}.`);
        emitSummary("REVISION_GUARD", "SKIPPED_INVALID_REVISION_HINT");
        return;
      }
      relevantUpdate = getUpdateByRevision(updatesByRevision, revisionHint);

      if (!relevantUpdate) {
        console.log("RUN STATUS: REVISION_GUARD");
        console.log("EXIT STATUS: SKIPPED_UPDATE_NOT_FOUND");
        console.log(`Could not find an update row with rev ${revisionHint}. Event may reference an unavailable revision.`);
        emitSummary("REVISION_GUARD", "SKIPPED_UPDATE_NOT_FOUND");
        return;
      }

      if (currentRevision !== null && revisionHint < currentRevision) {
        const staleAnalysis = analyzeStaleRevisionConflictFromUpdates({
          revisionHint,
          currentRevision,
          trackedFields,
          maxScan: staleScanLimit,
          updatesByRevision
        });

        if (!staleAnalysis.canProcess) {
          console.log("RUN STATUS: REVISION_GUARD");
          if (staleAnalysis.reason === "stale-scan-limit") {
            console.log("EXIT STATUS: SKIPPED_STALE_SCAN_LIMIT");
            console.log(
              `Revision hint ${revisionHint} is stale by ${staleAnalysis.gap} revisions and exceeds scan limit ${staleAnalysis.maxScan}.`
            );
            emitSummary("REVISION_GUARD", "SKIPPED_STALE_SCAN_LIMIT");
          } else {
            console.log("EXIT STATUS: SKIPPED_STALE_EVENT");
            const revisions = staleAnalysis.conflicts.map((c) => `${c.rev}:${c.revisedBy}`).join(", ");
            console.log(`Stale revision ${revisionHint} conflicts with tracked-field changes in later revisions: ${revisions}`);
            emitSummary("REVISION_GUARD", "SKIPPED_STALE_EVENT");
          }
          return;
        }

        console.log(
          `Revision hint ${revisionHint} is stale (current ${currentRevision}) but no tracked-field conflicts were found in ${staleAnalysis.scanned} later revisions.`
        );
      }
    } else if (isManualDispatch) {
      const manualRevision = parsePositiveInteger(workItem?.rev);
      if (manualRevision !== null) {
        relevantUpdate = getUpdateByRevision(updatesByRevision, manualRevision);
      } else {
        relevantUpdate = pickRelevantUpdate({ value: Array.from(updatesByRevision.values()) }, null);
      }
    } else {
      console.log("RUN STATUS: REVISION_GUARD");
      console.log("EXIT STATUS: SKIPPED_MISSING_REVISION_HINT");
      console.log("Missing revision hint for non-manual event. Skipping to avoid replaying historical revisions.");
      emitSummary("REVISION_GUARD", "SKIPPED_MISSING_REVISION_HINT");
      return;
    }
  } catch (error) {
    if (isWorkItemNotAccessibleError(error)) {
      console.log("EXIT STATUS: SKIPPED_INACCESSIBLE_WORK_ITEM");
      console.log(`Skipping work item ${workItemId}: inaccessible, deleted, or outside permissions.`);
      console.log(String(error?.message || error));
      emitSummary("REVISION_GUARD", "SKIPPED_INACCESSIBLE_WORK_ITEM");
      return;
    }
    throw error;
  }

  if (!relevantUpdate) {
    console.log("RUN STATUS: REVISION_GUARD");
    console.log("EXIT STATUS: SKIPPED_UPDATE_NOT_FOUND");
    console.log("Unable to resolve relevant update revision for this event.");
    emitSummary("REVISION_GUARD", "SKIPPED_UPDATE_NOT_FOUND");
    return;
  }

  const revisedBy = normalizeEmail(relevantUpdate?.revisedBy?.uniqueName || relevantUpdate?.revisedBy?.name || "");
  runSummary.revisedBy = revisedBy || runSummary.revisedBy;
  runSummary.trackedFieldsChanged = getTrackedFieldsChanged(relevantUpdate, trackedFields);
  if (revisedBy && automationActors.has(revisedBy)) {
    console.log("RUN STATUS: SELF_UPDATE_GUARD");
    console.log("EXIT STATUS: SKIPPED_AUTOMATION_SELF_UPDATE");
    console.log(`Update revision ${relevantUpdate.rev} was produced by automation actor '${revisedBy}'.`);
    emitSummary("SELF_UPDATE_GUARD", "SKIPPED_AUTOMATION_SELF_UPDATE");
    return;
  }

  if (!updateTouchesTrackedFields(relevantUpdate, trackedFields)) {
    console.log("RUN STATUS: NO_RELEVANT_FIELD_CHANGE");
    console.log("EXIT STATUS: SKIPPED_NO_RELEVANT_FIELD_CHANGE");
    console.log(`Update revision ${relevantUpdate.rev} did not modify tracked fields.`);
    logRevisionChangeDetails(relevantUpdate);
    emitSummary("NO_RELEVANT_FIELD_CHANGE", "SKIPPED_NO_RELEVANT_FIELD_CHANGE");
    return;
  }

  console.log(`Using update revision: ${relevantUpdate.rev ?? "unknown"}`);
  logRevisionChangeDetails(relevantUpdate);

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
    emitSummary("NO_TRIGGER_MATCH", "SKIPPED_NO_TRIGGER");
    return;
  }

  console.log("RUN STATUS: TRIGGER_MATCHED");

  let effectivePatchOps = filterNoopPatchOps(actions.patchOps, workItem.fields || {});
  if (actions.patchOps.length !== effectivePatchOps.length) {
    console.log(`Filtered out ${actions.patchOps.length - effectivePatchOps.length} no-op patch operation(s).`);
  }

  let notificationsToSend = testMode
    ? applyTestRecipientOverride(actions.notifications, testEmailOverride)
    : actions.notifications;

  const requestedRuleNames = Array.from(
    new Set([
      ...effectivePatchOps.map((op) => normalizeString(op.ruleName)),
      ...notificationsToSend.map((notification) => normalizeString(notification.ruleName || notification.type))
    ].filter((ruleName) => ruleName.length > 0))
  );
  const operationKeysByRule = new Map(
    requestedRuleNames.map((ruleName) => [
      ruleName,
      buildRuleOperationKey({
        workItemId,
        triggerRevision: relevantUpdate.rev,
        ruleName
      })
    ])
  );
  runSummary.rulesFired = requestedRuleNames;
  runSummary.actionKeys = Array.from(operationKeysByRule.values());

  let existingCommentItems = null;
  if (!dryRun && requestedRuleNames.length) {
    const existingComments = await getRecentWorkItemComments(orgUrl, project, pat, workItemId, 200);
    existingCommentItems = Array.isArray(existingComments?.comments)
      ? existingComments.comments
      : Array.isArray(existingComments?.value)
        ? existingComments.value
        : [];

    const seenOperationKeys = new Set();
    for (const comment of existingCommentItems) {
      for (const opKey of extractOperationKeys(comment?.text)) {
        seenOperationKeys.add(opKey.toLowerCase());
      }
    }

    const duplicateRuleNames = requestedRuleNames.filter((ruleName) => {
      const operationKey = normalizeString(operationKeysByRule.get(ruleName)).toLowerCase();
      return operationKey && seenOperationKeys.has(operationKey);
    });

    if (duplicateRuleNames.length) {
      const duplicateSet = new Set(duplicateRuleNames);
      effectivePatchOps = effectivePatchOps.filter((op) => !duplicateSet.has(normalizeString(op.ruleName)));
      notificationsToSend = notificationsToSend.filter(
        (notification) => !duplicateSet.has(normalizeString(notification.ruleName || notification.type))
      );
      console.log(`Skipped duplicate operation key(s) for rules: ${duplicateRuleNames.join(", ")}`);
    }
  }

  if (!effectivePatchOps.length && !actions.notifications.length) {
    console.log("RUN STATUS: TRIGGER_MATCHED_NO_ACTION");
    console.log("EXIT STATUS: SKIPPED_NO_ACTION");
    console.log("Trigger matched, but no field updates or notifications were required.");
    emitSummary("TRIGGER_MATCHED_NO_ACTION", "SKIPPED_NO_ACTION");
    return;
  }

  if (!effectivePatchOps.length && !notificationsToSend.length) {
    console.log("RUN STATUS: IDEMPOTENCY_GUARD");
    console.log("EXIT STATUS: SKIPPED_DUPLICATE_OPERATION");
    console.log("All actions were already applied for this work item revision and rule set.");
    emitSummary("IDEMPOTENCY_GUARD", "SKIPPED_DUPLICATE_OPERATION");
    return;
  }

  const workItemUrl = buildWorkItemUrl(orgUrl, project, workItemId);

  console.log(`Patch operations: ${effectivePatchOps.length}`);
  if (effectivePatchOps.length) {
    console.log(JSON.stringify(effectivePatchOps, null, 2));
  }

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
    if (effectivePatchOps.length) {
      await patchWorkItem(orgUrl, project, pat, workItemId, toAdoPatchOps(effectivePatchOps));
      console.log("Work item patch applied.");
    }

    if (notificationsToSend.length) {
      const comments = await addMentionComments({
        orgUrl,
        project,
        pat,
        workItemId,
        workItemUrl,
        notifications: notificationsToSend,
        triggerRevision: relevantUpdate.rev,
        existingCommentItems,
        operationKeysByRule
      });
      console.log("Mention comments added:");
      console.log(JSON.stringify(comments, null, 2));
    }
  } else {
    console.log("Dry run enabled. No patch and no mention comments were executed.");
  }

  console.log("EXIT STATUS: EXECUTED");
  console.log(`Done. Work item URL: ${workItemUrl}`);
  emitSummary("TRIGGER_MATCHED", "EXECUTED", {
    triggerRevision: relevantUpdate.rev,
    currentRevision
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Automation run failed.");
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  config,
  parsePositiveInteger,
  updateTouchesTrackedFields,
  getTrackedFieldsChanged,
  analyzeStaleRevisionConflictFromUpdates,
  buildActions,
  buildRuleOperationKey,
  extractOperationKeys,
  filterNoopPatchOps
};
