const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");

const configPath = path.join(process.cwd(), "config", "ado-quote-automation.config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

function requiredEnv(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return String(value).trim();
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

function isYes(value) {
  const v = normalizeString(value).toLowerCase();
  return v === "yes" || v === "true" || v === "1";
}

function encodeBasicPat(pat) {
  return Buffer.from(`:${pat}`).toString("base64");
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

async function getUpdates(orgUrl, project, pat, id) {
  return adoRequest({
    method: "GET",
    orgUrl,
    project,
    pat,
    endpoint: `/_apis/wit/workitems/${id}/updates?api-version=7.1`
  });
}

function getWorkItemId(eventPayload) {
  const fromInput = normalizeString(process.env.WORK_ITEM_ID);
  if (fromInput) return fromInput;

  const cp = eventPayload.client_payload || {};
  const resource = cp.resource || {};

  const candidates = [
    cp.workItemId,
    cp.work_item_id,
    cp.id,
    resource.id,
    resource.workItemId,
    resource.workItem?.id,
    resource.revision?.id,
    resource.fields?.["System.Id"],
    resource.resource?.id
  ];

  for (const candidate of candidates) {
    if (!isEmpty(candidate)) return String(candidate);
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

function pickRelevantUpdate(updates, revisionHint) {
  const updateList = Array.isArray(updates?.value) ? updates.value.slice() : [];
  if (updateList.length === 0) {
    return { rev: null, fields: {} };
  }

  if (revisionHint !== null) {
    const exact = updateList.find((u) => Number(u.rev) === Number(revisionHint));
    if (exact) return exact;
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
  }

  if (quoteStatusTransition.changed && normalizeString(quoteStatusTransition.newValue) === quoteValues.pendingQuote) {
    notifications.push({
      type: "quote-ready",
      to: configObj.emails.quoteReadyTo,
      subject: `[ADO #${workItem.id}] Quote status is ${quoteValues.pendingQuote}`,
      body: `Work item #${workItem.id} (${title}) changed to '${quoteValues.pendingQuote}'.\n\nArea: ${areaPath}`
    });
  }

  if (
    releasedTransition.changed &&
    !parseBoolean(releasedTransition.oldValue) &&
    parseBoolean(releasedTransition.newValue)
  ) {
    const pmEmail = configObj.emails.pmByAreaPath[areaPath];
    if (pmEmail) {
      notifications.push({
        type: "released-for-development",
        to: [pmEmail],
        subject: `[ADO #${workItem.id}] Released for Development enabled`,
        body: `Work item #${workItem.id} (${title}) was released for development.\n\nArea: ${areaPath}`
      });
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

async function sendNotifications(notifications, context) {
  if (!notifications.length) {
    return [];
  }

  const transporter = nodemailer.createTransport({
    host: requiredEnv("SMTP_HOST"),
    port: Number(requiredEnv("SMTP_PORT")),
    secure: parseBoolean(process.env.SMTP_SECURE),
    auth: {
      user: requiredEnv("SMTP_USER"),
      pass: requiredEnv("SMTP_PASS")
    }
  });

  const from = requiredEnv("SMTP_FROM");
  const results = [];

  for (const notification of notifications) {
    const to = Array.isArray(notification.to) ? notification.to.join(",") : String(notification.to);
    const info = await transporter.sendMail({
      from,
      to,
      subject: notification.subject,
      text: `${notification.body}\n\nLink: ${context.workItemUrl}`
    });

    results.push({
      type: notification.type,
      to,
      messageId: info.messageId
    });
  }

  return results;
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
    subject: `[TEST MODE] ${notification.subject}`,
    body: `${notification.body}\n\nOriginal recipients were overridden to ${overrideEmail}.`
  }));
}

async function main() {
  const orgUrl = requiredEnv("ADO_ORG_URL");
  const project = requiredEnv("ADO_PROJECT");
  const pat = requiredEnv("ADO_PAT");

  const eventPayload = readEventPayload();
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

  const workItem = await getWorkItem(orgUrl, project, pat, workItemId, fieldsToFetch);
  const updates = await getUpdates(orgUrl, project, pat, workItemId);
  const relevantUpdate = pickRelevantUpdate(updates, revisionHint);

  console.log(`Using update revision: ${relevantUpdate.rev ?? "unknown"}`);

  const actions = buildActions({
    workItem,
    update: relevantUpdate,
    configObj: config,
    testMode
  });

  if (!actions.shouldRun) {
    console.log(actions.reason);
    return;
  }

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
        notificationsToSend.map((n) => ({ type: n.type, to: n.to, subject: n.subject })),
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
      const sent = await sendNotifications(notificationsToSend, { workItemUrl });
      console.log("Notifications sent:");
      console.log(JSON.stringify(sent, null, 2));
    }
  } else {
    console.log("Dry run enabled. No patch and no email actions were executed.");
  }

  console.log(`Done. Work item URL: ${workItemUrl}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
