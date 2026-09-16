import { describe, it, expect } from "vitest";

// These imports will fail until the implementation exists
import {
  NODE_NAME_REGEX,
  RESERVED_NODE_NAMES,
  NODE_HEALTH_VALUES,
  NodeNameSchema,
  NodeHealthSchema,
  NodeSchema,
  NodesMapSchema,
  FederationSettingsSchema,
  PathSafetySchema,
  validateOrchestratorOverlay,
} from "../../src/models/federation-config.js";

describe("NODE_NAME_REGEX", () => {
  it("matches valid single-char name", () => {
    expect(NODE_NAME_REGEX.test("a")).toBe(true);
  });

  it("matches valid multi-char name", () => {
    expect(NODE_NAME_REGEX.test("engine")).toBe(true);
  });

  it("matches name with digits, hyphens, underscores", () => {
    expect(NODE_NAME_REGEX.test("my-app_2")).toBe(true);
  });

  it("matches exactly 64-char name", () => {
    const name = "a" + "b".repeat(63);
    expect(name.length).toBe(64);
    expect(NODE_NAME_REGEX.test(name)).toBe(true);
  });

  it("rejects 65-char name", () => {
    const name = "a" + "b".repeat(64);
    expect(name.length).toBe(65);
    expect(NODE_NAME_REGEX.test(name)).toBe(false);
  });

  it("rejects empty string", () => {
    expect(NODE_NAME_REGEX.test("")).toBe(false);
  });

  it("rejects name starting with digit", () => {
    expect(NODE_NAME_REGEX.test("2engine")).toBe(false);
  });

  it("rejects name starting with hyphen", () => {
    expect(NODE_NAME_REGEX.test("-engine")).toBe(false);
  });

  it("rejects name starting with underscore", () => {
    expect(NODE_NAME_REGEX.test("_engine")).toBe(false);
  });

  it("rejects uppercase letters", () => {
    expect(NODE_NAME_REGEX.test("Engine")).toBe(false);
  });

  it("rejects colons", () => {
    expect(NODE_NAME_REGEX.test("my:node")).toBe(false);
  });

  it("rejects spaces", () => {
    expect(NODE_NAME_REGEX.test("my node")).toBe(false);
  });

  it("rejects '.' (ISS-1181: reserved on the node= parameter for the orchestrator's own board, so a real node can never be named this)", () => {
    expect(NODE_NAME_REGEX.test(".")).toBe(false);
  });
});

describe("NodeNameSchema", () => {
  it("accepts valid name", () => {
    expect(NodeNameSchema.safeParse("engine").success).toBe(true);
  });

  it("rejects reserved name .story", () => {
    expect(NodeNameSchema.safeParse(".story").success).toBe(false);
  });

  it("rejects reserved name node_modules", () => {
    expect(NodeNameSchema.safeParse("node_modules").success).toBe(false);
  });

  it("rejects reserved name .git", () => {
    expect(NodeNameSchema.safeParse(".git").success).toBe(false);
  });

  it("rejects invalid regex", () => {
    expect(NodeNameSchema.safeParse("My-Engine").success).toBe(false);
  });
});

describe("NodeHealthSchema", () => {
  for (const value of ["green", "yellow", "red", "grey"] as const) {
    it(`accepts "${value}"`, () => {
      expect(NodeHealthSchema.safeParse(value).success).toBe(true);
    });
  }

  it("rejects invalid value", () => {
    expect(NodeHealthSchema.safeParse("blue").success).toBe(false);
  });
});

describe("PathSafetySchema", () => {
  it("accepts valid absolute path", () => {
    expect(PathSafetySchema.safeParse("/Users/dev/project").success).toBe(true);
  });

  it("accepts tilde path", () => {
    expect(PathSafetySchema.safeParse("~/Developer/engine").success).toBe(true);
  });

  it("accepts relative path without traversal", () => {
    expect(PathSafetySchema.safeParse("./engine").success).toBe(true);
  });

  it("rejects path with .. segments", () => {
    expect(PathSafetySchema.safeParse("/Users/../etc/passwd").success).toBe(false);
  });

  it("rejects path with null bytes", () => {
    expect(PathSafetySchema.safeParse("/Users/dev\0/project").success).toBe(false);
  });

  it("rejects empty string", () => {
    expect(PathSafetySchema.safeParse("").success).toBe(false);
  });

  it("rejects backslash traversal segments", () => {
    expect(PathSafetySchema.safeParse("..\\other-repo").success).toBe(false);
    expect(PathSafetySchema.safeParse("node\\..\\other").success).toBe(false);
  });
});

describe("NodeSchema", () => {
  const validNode = {
    path: "~/Developer/engine",
    stack: "swift-spm",
    role: "Headless engine",
    summary: "Core pipeline working",
    health: "green" as const,
    dependsOn: [],
  };

  it("accepts fully specified node", () => {
    const result = NodeSchema.safeParse(validNode);
    expect(result.success).toBe(true);
  });

  it("accepts node with only required path, applies defaults", () => {
    const result = NodeSchema.safeParse({ path: "~/Developer/engine" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.health).toBe("grey");
      expect(result.data.stack).toBe("");
      expect(result.data.role).toBe("");
      expect(result.data.summary).toBe("");
      expect(result.data.dependsOn).toEqual([]);
    }
  });

  it("rejects node without path", () => {
    expect(NodeSchema.safeParse({ health: "green" }).success).toBe(false);
  });

  it("rejects role exceeding 120 chars", () => {
    expect(NodeSchema.safeParse({ ...validNode, role: "x".repeat(121) }).success).toBe(false);
  });

  it("accepts role at exactly 120 chars", () => {
    expect(NodeSchema.safeParse({ ...validNode, role: "x".repeat(120) }).success).toBe(true);
  });

  it("rejects summary exceeding 200 chars", () => {
    expect(NodeSchema.safeParse({ ...validNode, summary: "x".repeat(201) }).success).toBe(false);
  });

  it("accepts summary at exactly 200 chars", () => {
    expect(NodeSchema.safeParse({ ...validNode, summary: "x".repeat(200) }).success).toBe(true);
  });

  it("rejects stack exceeding 40 chars", () => {
    expect(NodeSchema.safeParse({ ...validNode, stack: "x".repeat(41) }).success).toBe(false);
  });

  it("accepts stack at exactly 40 chars", () => {
    expect(NodeSchema.safeParse({ ...validNode, stack: "x".repeat(40) }).success).toBe(true);
  });

  it("validates dependsOn entries against NodeNameSchema", () => {
    expect(NodeSchema.safeParse({ ...validNode, dependsOn: ["engine"] }).success).toBe(true);
    expect(NodeSchema.safeParse({ ...validNode, dependsOn: ["Invalid"] }).success).toBe(false);
  });

  it("preserves unknown keys via passthrough", () => {
    const result = NodeSchema.safeParse({ ...validNode, customField: true });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).customField).toBe(true);
    }
  });

  it("accepts kind as free string", () => {
    expect(NodeSchema.safeParse({ ...validNode, kind: "library" }).success).toBe(true);
    expect(NodeSchema.safeParse({ ...validNode, kind: "bridge" }).success).toBe(true);
    expect(NodeSchema.safeParse({ ...validNode, kind: "custom-thing" }).success).toBe(true);
  });

  it("rejects kind that is empty or too long", () => {
    expect(NodeSchema.safeParse({ ...validNode, kind: "" }).success).toBe(false);
    expect(NodeSchema.safeParse({ ...validNode, kind: "a".repeat(33) }).success).toBe(false);
  });

  it("accepts missing kind as undefined", () => {
    const result = NodeSchema.safeParse(validNode);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.kind).toBeUndefined();
  });

  it("accepts links with to and via", () => {
    const result = NodeSchema.safeParse({
      ...validNode,
      links: [{ to: "cloud", via: "streaming API" }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.links).toHaveLength(1);
      expect(result.data.links![0]!.to).toBe("cloud");
      expect(result.data.links![0]!.via).toBe("streaming API");
    }
  });

  it("accepts links without via", () => {
    const result = NodeSchema.safeParse({
      ...validNode,
      links: [{ to: "engine" }],
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.links![0]!.via).toBeUndefined();
  });

  it("validates link to against NodeNameSchema", () => {
    expect(NodeSchema.safeParse({ ...validNode, links: [{ to: "Valid-Name" }] }).success).toBe(false);
    expect(NodeSchema.safeParse({ ...validNode, links: [{ to: "engine" }] }).success).toBe(true);
  });

  it("accepts missing links as undefined", () => {
    const result = NodeSchema.safeParse(validNode);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.links).toBeUndefined();
  });
});

describe("NodesMapSchema", () => {
  it("accepts valid nodes map", () => {
    const map = {
      engine: { path: "~/Developer/engine" },
      cloud: { path: "~/Developer/cloud" },
    };
    expect(NodesMapSchema.safeParse(map).success).toBe(true);
  });

  it("rejects invalid node key", () => {
    const map = {
      "My-Engine": { path: "~/Developer/engine" },
    };
    expect(NodesMapSchema.safeParse(map).success).toBe(false);
  });

  it("rejects reserved node key", () => {
    const map = {
      ".story": { path: "~/Developer/engine" },
    };
    expect(NodesMapSchema.safeParse(map).success).toBe(false);
  });
});

describe("FederationSettingsSchema", () => {
  it("defaults allowNodeWrites to false when omitted", () => {
    const result = FederationSettingsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allowNodeWrites).toBe(false);
    }
  });

  it("accepts explicit allowNodeWrites true", () => {
    const result = FederationSettingsSchema.safeParse({ allowNodeWrites: true });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allowNodeWrites).toBe(true);
    }
  });

  it("rejects wrong type for allowNodeWrites", () => {
    expect(FederationSettingsSchema.safeParse({ allowNodeWrites: "yes" }).success).toBe(false);
  });

  it("preserves unknown keys via passthrough", () => {
    const result = FederationSettingsSchema.safeParse({ futureFlag: true });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).futureFlag).toBe(true);
    }
  });
});

describe("validateOrchestratorOverlay", () => {
  const baseConfig = {
    version: 2,
    schemaVersion: 2,
    project: "studio",
    type: "orchestrator",
    language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  };

  it("returns valid for well-formed orchestrator config", () => {
    const config = {
      ...baseConfig,
      nodes: {
        engine: { path: "~/Developer/engine", health: "green", dependsOn: [] },
        cloud: { path: "~/Developer/cloud", health: "yellow", dependsOn: ["engine"] },
      },
    };
    const result = validateOrchestratorOverlay(config);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("is a no-op for non-orchestrator config", () => {
    const config = { ...baseConfig, type: "npm" };
    const result = validateOrchestratorOverlay(config);
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("is a no-op for orchestrator without nodes", () => {
    const result = validateOrchestratorOverlay(baseConfig);
    expect(result.valid).toBe(true);
  });

  it("detects self-reference cycle (A depends on A)", () => {
    const config = {
      ...baseConfig,
      nodes: {
        engine: { path: "~/Dev/engine", dependsOn: ["engine"] },
      },
    };
    const result = validateOrchestratorOverlay(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.toLowerCase().includes("cycle"))).toBe(true);
  });

  it("detects mutual cycle (A->B, B->A)", () => {
    const config = {
      ...baseConfig,
      nodes: {
        engine: { path: "~/Dev/engine", dependsOn: ["cloud"] },
        cloud: { path: "~/Dev/cloud", dependsOn: ["engine"] },
      },
    };
    const result = validateOrchestratorOverlay(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.toLowerCase().includes("cycle"))).toBe(true);
  });

  it("detects transitive cycle (A->B->C->A)", () => {
    const config = {
      ...baseConfig,
      nodes: {
        a: { path: "~/Dev/a", dependsOn: ["b"] },
        b: { path: "~/Dev/b", dependsOn: ["c"] },
        c: { path: "~/Dev/c", dependsOn: ["a"] },
      },
    };
    const result = validateOrchestratorOverlay(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.toLowerCase().includes("cycle"))).toBe(true);
  });

  it("detects dangling dependsOn reference", () => {
    const config = {
      ...baseConfig,
      nodes: {
        engine: { path: "~/Dev/engine", dependsOn: ["nonexistent"] },
      },
    };
    const result = validateOrchestratorOverlay(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes("nonexistent"))).toBe(true);
  });

  it("warns on duplicate paths", () => {
    const config = {
      ...baseConfig,
      nodes: {
        engine: { path: "~/Dev/shared" },
        cloud: { path: "~/Dev/shared" },
      },
    };
    const result = validateOrchestratorOverlay(config);
    expect(result.warnings.some((w: string) => w.toLowerCase().includes("duplicate"))).toBe(true);
  });

  it("errors on reserved node name", () => {
    const config = {
      ...baseConfig,
      nodes: {
        "node_modules": { path: "~/Dev/nm" },
      },
    };
    const result = validateOrchestratorOverlay(config);
    expect(result.valid).toBe(false);
  });

  it("allows valid non-cyclic dependency chain", () => {
    const config = {
      ...baseConfig,
      nodes: {
        engine: { path: "~/Dev/engine", dependsOn: [] },
        components: { path: "~/Dev/comp", dependsOn: ["engine"] },
        conductor: { path: "~/Dev/cond", dependsOn: ["engine", "components"] },
      },
    };
    const result = validateOrchestratorOverlay(config);
    expect(result.valid).toBe(true);
  });

  it("warns on link referencing non-existent node", () => {
    const config = {
      ...baseConfig,
      nodes: {
        engine: { path: "~/Dev/engine", links: [{ to: "missing-node" }] },
        cloud: { path: "~/Dev/cloud" },
      },
    };
    const result = validateOrchestratorOverlay(config);
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w: string) => w.includes("missing-node"))).toBe(true);
  });

  it("accepts valid link targets without warnings", () => {
    const config = {
      ...baseConfig,
      nodes: {
        engine: { path: "~/Dev/engine", links: [{ to: "cloud", via: "API" }] },
        cloud: { path: "~/Dev/cloud" },
      },
    };
    const result = validateOrchestratorOverlay(config);
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });
});
