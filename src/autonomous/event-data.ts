export function buildAutoStartEventData(opts: {
  recipe: string;
  branch: string | null;
  head: string | undefined;
  targetWork: string[];
  targetWorkDisplayIds: Record<string, string> | undefined;
}): Record<string, unknown> {
  const hasTargets = opts.targetWork.length > 0;
  return {
    recipe: opts.recipe,
    branch: opts.branch,
    head: opts.head,
    mode: "auto",
    ...(hasTargets ? { targetWork: opts.targetWork } : {}),
    ...(hasTargets ? { displayIdMap: opts.targetWorkDisplayIds ?? {} } : {}),
  };
}

export function buildTieredStartEventData(opts: {
  recipe: string;
  branch: string | null;
  head: string | undefined;
  mode: string;
  canonicalTicketId: string;
  displayId: string;
}): Record<string, unknown> {
  const differs = opts.canonicalTicketId !== opts.displayId;
  return {
    recipe: opts.recipe,
    branch: opts.branch,
    head: opts.head,
    mode: opts.mode,
    ticketId: opts.canonicalTicketId,
    ...(differs ? { displayIdMap: { [opts.canonicalTicketId]: opts.displayId } } : {}),
  };
}
