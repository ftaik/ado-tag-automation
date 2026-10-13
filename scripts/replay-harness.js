const fs = require("fs");
const path = require("path");

const {
  config,
  updateTouchesTrackedFields,
  getTrackedFieldsChanged,
  analyzeStaleRevisionConflictFromUpdates,
  buildActions,
  buildRuleOperationKey,
  extractOperationKeys,
  filterNoopPatchOps
} = require("./ado-quote-automation");

const trackedFields = [
  config.fieldRefs.billable,
  config.fieldRefs.quoteStatus,
  config.fieldRefs.releasedForDevelopment,
  ...config.estimateFields
];

function loadFixture(fileName) {
  const fullPath = path.join(process.cwd(), fileName);
  const raw = fs.readFileSync(fullPath, "utf8");
  const parsed = JSON.parse(raw);
  const updates = Array.isArray(parsed?.value) ? parsed.value : [];
  return { fileName, updates };
}

function normalizeIdentity(update) {
  const name = String(update?.revisedBy?.uniqueName || update?.revisedBy?.name || "").toLowerCase();
  return name;
}

function toMapByRevision(updates) {
  const map = new Map();
  for (const update of updates) {
    const rev = Number(update?.rev);
    if (Number.isInteger(rev) && rev > 0) {
      map.set(rev, update);
    }
  }
  return map;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function findWindow(updates, predicate, maxWindow = 8) {
  const sorted = updates
    .filter((u) => Number.isInteger(Number(u?.rev)))
    .slice()
    .sort((a, b) => Number(a.rev) - Number(b.rev));

  for (let i = 0; i < sorted.length - 1; i += 1) {
    for (let j = i + 1; j < Math.min(sorted.length, i + maxWindow); j += 1) {
      const fromRev = Number(sorted[i].rev);
      const toRev = Number(sorted[j].rev);
      if (!Number.isInteger(fromRev) || !Number.isInteger(toRev) || toRev <= fromRev) {
        continue;
      }

      const range = [];
      for (let rev = fromRev + 1; rev <= toRev; rev += 1) {
        const update = sorted.find((u) => Number(u.rev) === rev);
        if (!update) {
          range.length = 0;
          break;
        }
        range.push(update);
      }

      if (!range.length) {
        continue;
      }

      if (predicate(range)) {
        return { revisionHint: fromRev, currentRevision: toRev, range };
      }
    }
  }

  return null;
}

const scenarios = [];

function scenario(name, expectedExitStatus, fn) {
  scenarios.push({ name, expectedExitStatus, fn });
}

const fixture33827 = loadFixture("tmp-33827-updates.json");
const fixture33828 = loadFixture("tmp-33828-updates.json");

scenario("relation-only update", "SKIPPED_NO_RELEVANT_FIELD_CHANGE", () => {
  const update = fixture33828.updates.find((u) => {
    const fields = Object.keys(u?.fields || {});
    if (!fields.length) return false;
    return !updateTouchesTrackedFields(u, trackedFields);
  });

  assert(update, "Could not find a non-tracked update in fixture 33828.");
  assert(updateTouchesTrackedFields(update, trackedFields) === false, "Expected relation-only/non-tracked update.");
});

scenario("comment-only update", "SKIPPED_NO_RELEVANT_FIELD_CHANGE", () => {
  const update = fixture33827.updates.find((u) => {
    const fields = Object.keys(u?.fields || {});
    return fields.includes("System.History") && !updateTouchesTrackedFields(u, trackedFields);
  });

  assert(update, "Could not find a comment-only update in fixture 33827.");
});

scenario("true billable transition", "EXECUTED", () => {
  const update = {
    rev: 500,
    fields: {
      [config.fieldRefs.billable]: { oldValue: "No", newValue: "Yes" }
    }
  };

  const workItem = {
    id: 33828,
    fields: {
      [config.fieldRefs.workItemType]: config.workItemTypes[0],
      [config.fieldRefs.areaPath]: "Shepherd CMMS\\Operations",
      [config.fieldRefs.title]: "Harness billable transition",
      [config.fieldRefs.quoteStatus]: config.quoteStatusValues.notNeeded
    }
  };

  const actions = buildActions({ workItem, update, configObj: config, testMode: false });
  assert(actions.shouldRun, "Billable transition should be runnable.");
  assert(actions.patchOps.some((op) => String(op.path).includes(config.fieldRefs.quoteStatus)), "Expected quote status patch.");
  assert(actions.patchOps.some((op) => String(op.path).includes(config.fieldRefs.state)), "Expected state patch.");
});

scenario("estimate transition", "EXECUTED", () => {
  const estimateRef = config.estimateFields[0];
  const update = {
    rev: 501,
    fields: {
      [estimateRef]: { oldValue: "", newValue: "4" }
    }
  };

  const workItem = {
    id: 33828,
    fields: {
      [config.fieldRefs.workItemType]: config.workItemTypes[0],
      [config.fieldRefs.areaPath]: "Shepherd CMMS\\Operations",
      [config.fieldRefs.title]: "Harness estimate transition",
      [config.fieldRefs.quoteStatus]: config.quoteStatusValues.pendingHours
    }
  };

  const actions = buildActions({ workItem, update, configObj: config, testMode: false });
  assert(actions.patchOps.some((op) => String(op.path).includes(config.fieldRefs.quoteStatus)), "Expected transition to pending quote.");
});

scenario("stale event with tracked-field conflict", "SKIPPED_STALE_EVENT", () => {
  const conflictWindow = findWindow(
    fixture33828.updates,
    (range) => range.some((u) => updateTouchesTrackedFields(u, trackedFields)),
    12
  );
  assert(conflictWindow, "Could not find stale conflict window in fixture 33828.");

  const updatesByRevision = toMapByRevision(conflictWindow.range);
  const analysis = analyzeStaleRevisionConflictFromUpdates({
    revisionHint: conflictWindow.revisionHint,
    currentRevision: conflictWindow.currentRevision,
    trackedFields,
    maxScan: 40,
    updatesByRevision
  });

  assert(analysis.canProcess === false, "Expected stale conflict to block processing.");
  assert(analysis.reason === "stale-tracked-field-conflict", "Expected stale-tracked-field-conflict reason.");
});

scenario("stale event without tracked-field conflict", "ALLOW_STALE_NO_CONFLICT", () => {
  const noConflictWindow = findWindow(
    fixture33827.updates,
    (range) => range.every((u) => !updateTouchesTrackedFields(u, trackedFields)),
    8
  );

  let analysis;
  if (noConflictWindow) {
    const updatesByRevision = toMapByRevision(noConflictWindow.range);
    analysis = analyzeStaleRevisionConflictFromUpdates({
      revisionHint: noConflictWindow.revisionHint,
      currentRevision: noConflictWindow.currentRevision,
      trackedFields,
      maxScan: 40,
      updatesByRevision
    });
  } else {
    const syntheticMap = new Map([
      [11, { rev: 11, fields: { "System.History": { oldValue: "", newValue: "comment" } } }],
      [12, { rev: 12, fields: { "System.ChangedDate": { oldValue: "a", newValue: "b" } } }]
    ]);
    analysis = analyzeStaleRevisionConflictFromUpdates({
      revisionHint: 10,
      currentRevision: 12,
      trackedFields,
      maxScan: 40,
      updatesByRevision: syntheticMap
    });
  }

  assert(analysis.canProcess === true, "Expected stale no-conflict event to be allowed.");
  assert(analysis.reason === "stale-no-conflict", "Expected stale-no-conflict reason.");
});

scenario("self-update event", "SKIPPED_AUTOMATION_SELF_UPDATE", () => {
  const automationUpdate = fixture33828.updates.find((u) => {
    const identity = normalizeIdentity(u);
    return identity.includes("dev@shepherd.build") || identity.includes("app@shepherd");
  });

  assert(automationUpdate, "Could not find automation-authored update in fixture 33828.");
});

scenario("operation key deterministic and parseable", "SKIPPED_DUPLICATE_OPERATION", () => {
  const key = buildRuleOperationKey({ workItemId: 33828, triggerRevision: 150, ruleName: "pending-quote-notification" });
  const comment = `<code>operation-key:${key}</code>`;
  const parsed = extractOperationKeys(comment);
  assert(parsed.includes(key.toLowerCase()), "Expected operation key parser to round-trip generated key.");
});

scenario("no-op patch filtering", "SKIPPED_NO_ACTION", () => {
  const patchOps = [
    { op: "add", path: `/fields/${config.fieldRefs.quoteStatus}`, value: config.quoteStatusValues.pendingQuote, ruleName: "x" },
    { op: "add", path: `/fields/${config.fieldRefs.state}`, value: config.stateValues.new, ruleName: "x" }
  ];

  const fields = {
    [config.fieldRefs.quoteStatus]: config.quoteStatusValues.pendingQuote,
    [config.fieldRefs.state]: config.stateValues.new
  };

  const filtered = filterNoopPatchOps(patchOps, fields);
  assert(filtered.length === 0, "Expected all patch operations to be filtered as no-op.");
});

let failures = 0;
for (const entry of scenarios) {
  try {
    entry.fn();
    console.log(`PASS - ${entry.name} -> expected ${entry.expectedExitStatus}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL - ${entry.name} -> expected ${entry.expectedExitStatus}`);
    console.error(String(error?.message || error));
  }
}

if (failures > 0) {
  console.error(`Replay harness finished with ${failures} failure(s).`);
  process.exit(1);
}

console.log(`Replay harness finished successfully. Scenarios: ${scenarios.length}`);
