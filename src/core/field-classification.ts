export type MergeRule =
  | { kind: "identity" }
  | { kind: "commutative" }
  | { kind: "monotonic"; compare: "max" }
  | { kind: "latest-wins"; timestampField: string }
  | { kind: "hard-conflict" }
  | { kind: "coupled"; group: string; members: string[] };

export type EntityType = "ticket" | "issue" | "note" | "lesson";

const TICKET_RULES: Record<string, MergeRule> = {
  id: { kind: "identity" },
  createdDate: { kind: "identity" },
  createdAt: { kind: "identity" },
  createdBy: { kind: "identity" },

  blockedBy: { kind: "commutative" },
  crossNodeBlockedBy: { kind: "commutative" },
  previousDisplayIds: { kind: "commutative" },

  title: { kind: "hard-conflict" },
  description: { kind: "hard-conflict" },
  type: { kind: "hard-conflict" },
  phase: { kind: "hard-conflict" },
  order: { kind: "hard-conflict" },
  rank: { kind: "hard-conflict" },
  parentTicket: { kind: "hard-conflict" },
  displayId: { kind: "hard-conflict" },
  assignedTo: { kind: "hard-conflict" },
  lastModifiedBy: { kind: "hard-conflict" },
  claimedBySession: { kind: "hard-conflict" },
  updatedDate: { kind: "hard-conflict" },

  status: { kind: "coupled", group: "ticket-status", members: ["status", "completedDate", "lifecycle"] },
  completedDate: { kind: "coupled", group: "ticket-status", members: ["status", "completedDate", "lifecycle"] },
  lifecycle: { kind: "coupled", group: "ticket-status", members: ["status", "completedDate", "lifecycle"] },

  deletedAt: { kind: "hard-conflict" },
  deletedBy: { kind: "hard-conflict" },

  claim: { kind: "latest-wins", timestampField: "since" },
};

const ISSUE_RULES: Record<string, MergeRule> = {
  id: { kind: "identity" },
  discoveredDate: { kind: "identity" },
  createdAt: { kind: "identity" },
  createdBy: { kind: "identity" },

  relatedTickets: { kind: "commutative" },
  components: { kind: "commutative" },
  location: { kind: "commutative" },
  previousDisplayIds: { kind: "commutative" },

  title: { kind: "hard-conflict" },
  severity: { kind: "hard-conflict" },
  impact: { kind: "hard-conflict" },
  resolution: { kind: "hard-conflict" },
  order: { kind: "hard-conflict" },
  phase: { kind: "hard-conflict" },
  rank: { kind: "hard-conflict" },
  displayId: { kind: "hard-conflict" },
  assignedTo: { kind: "hard-conflict" },
  lastModifiedBy: { kind: "hard-conflict" },

  status: { kind: "coupled", group: "issue-status", members: ["status", "resolvedDate"] },
  resolvedDate: { kind: "coupled", group: "issue-status", members: ["status", "resolvedDate"] },

  lifecycle: { kind: "hard-conflict" },
  deletedAt: { kind: "hard-conflict" },
  deletedBy: { kind: "hard-conflict" },
};

const NOTE_RULES: Record<string, MergeRule> = {
  id: { kind: "identity" },
  createdDate: { kind: "identity" },
  createdAt: { kind: "identity" },
  createdBy: { kind: "identity" },

  tags: { kind: "commutative" },
  previousDisplayIds: { kind: "commutative" },

  title: { kind: "hard-conflict" },
  content: { kind: "hard-conflict" },
  status: { kind: "hard-conflict" },
  updatedDate: { kind: "hard-conflict" },
  displayId: { kind: "hard-conflict" },
  rank: { kind: "hard-conflict" },
  lifecycle: { kind: "hard-conflict" },
  deletedAt: { kind: "hard-conflict" },
  deletedBy: { kind: "hard-conflict" },
};

const LESSON_RULES: Record<string, MergeRule> = {
  id: { kind: "identity" },
  createdDate: { kind: "identity" },
  createdAt: { kind: "identity" },
  createdBy: { kind: "identity" },

  tags: { kind: "commutative" },
  previousDisplayIds: { kind: "commutative" },

  reinforcements: { kind: "monotonic", compare: "max" },

  title: { kind: "hard-conflict" },
  content: { kind: "hard-conflict" },
  context: { kind: "hard-conflict" },
  source: { kind: "hard-conflict" },
  lastValidated: { kind: "hard-conflict" },
  updatedDate: { kind: "hard-conflict" },
  supersedes: { kind: "hard-conflict" },
  status: { kind: "hard-conflict" },
  displayId: { kind: "hard-conflict" },
  rank: { kind: "hard-conflict" },
  lifecycle: { kind: "hard-conflict" },
  deletedAt: { kind: "hard-conflict" },
  deletedBy: { kind: "hard-conflict" },
};

const RULES_BY_TYPE: Record<string, Record<string, MergeRule>> = {
  ticket: TICKET_RULES,
  issue: ISSUE_RULES,
  note: NOTE_RULES,
  lesson: LESSON_RULES,
};

export function getMergeRules(entityType: EntityType | string): Record<string, MergeRule> {
  return RULES_BY_TYPE[entityType] ?? {};
}

export function getCoupledGroups(entityType: EntityType): Array<{ group: string; members: string[] }> {
  const rules = getMergeRules(entityType);
  const seen = new Set<string>();
  const groups: Array<{ group: string; members: string[] }> = [];
  for (const rule of Object.values(rules)) {
    if (rule.kind === "coupled" && !seen.has(rule.group)) {
      seen.add(rule.group);
      groups.push({ group: rule.group, members: [...rule.members] });
    }
  }
  return groups;
}
