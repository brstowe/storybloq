export type { ResolvedNode } from "./resolver.js";
export { resolveNodePath, resolveAllNodes } from "./resolver.js";

export type { NodeScanSummary, NodeScanResult, ScanOptions } from "./scanner.js";
export { scanNodeSummary, scanAllSummaries, loadNodeFullState } from "./scanner.js";

export type { FederationState, FederationNodeEntry } from "./state.js";
export { buildFederationState } from "./state.js";

export type { FederationCache, CachedNodeSummary } from "./cache.js";
export { readFederationCache, writeFederationCache } from "./cache.js";

export type { CrossNodeRefStatus } from "./cross-node-resolver.js";
export { CrossNodeBlockingResolver } from "./cross-node-resolver.js";

export type { HandoverDigestEntry } from "./handover-digest.js";
export { buildHandoverDigest } from "./handover-digest.js";

export type { LatestHandoverInfo } from "./handover-utils.js";
export { findLatestHandover } from "./handover-utils.js";

export type { NodeRecommendationLoadWarning, NodeRecommendationsLoadResult } from "./node-recommend.js";
export { loadNodeRecommendations } from "./node-recommend.js";

export type { OrchestratorLink } from "./inherit.js";
export {
  findOrchestratorLink,
  loadInheritedLessons,
  loadInheritedNotes,
  inheritedLessonsFor,
  inheritedNotesFor,
  markInheritedTitle,
} from "./inherit.js";
