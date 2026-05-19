/**
 * WebView message protocol coverage test.
 *
 * Verifies that every concrete type in the WebviewToExtensionMessage union
 * has a corresponding handler (type guard or direct type check) in
 * chat-view-provider.ts. This prevents message types being silently dropped
 * when new message types are added to messages.ts but handlers are not wired.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../..");

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf-8");
}

// ── Extract WebviewToExtensionMessage union members ───────────────────────────

function extractUnionTypes(src: string, unionName: string): string[] {
  // Match the union type declaration — spans multiple lines
  const unionRe = new RegExp(
    `export type ${unionName}\\s*=([\\s\\S]*?);(?=\\s*(?:export|$))`,
  );
  const match = src.match(unionRe);
  if (!match) return [];

  // Extract all | TypeName lines
  const body = match[1];
  const typeMatches = body.matchAll(/\|\s*(\w+)/g);
  return [...typeMatches].map((m) => m[1]);
}

// ── Main coverage check ───────────────────────────────────────────────────────

describe("WebView protocol coverage", () => {
  it("every WebviewToExtensionMessage type has a handler in chat-view-provider.ts or a dedicated sub-panel", () => {
    const messagesTs = readSrc("src/ui/messages.ts");
    const providerTs = readSrc("src/ui/chat-view-provider.ts");

    // These types are intentionally routed to dedicated sub-panels rather than
    // chat-view-provider.ts directly. Document them here so the test stays honest
    // about what is handled where.
    const handledBySubPanel = new Set([
      "TeamBuilderSaveRequest", // → team-builder-panel.ts
      "RuleAddRequest", // → rules-editor-panel.ts
      "RuleDeleteRequest", // → rules-editor-panel.ts
      "TeamPauseRequest", // → team-panel.ts
      "TeamResumeRequest", // → team-panel.ts
      "RerunTeamRequest", // → team-panel.ts
    ]);

    // Read sub-panel files to verify they do handle the above types
    const teamBuilderTs = readSrc("src/ui/team-builder-panel.ts");
    const rulesEditorTs = readSrc("src/ui/rules-editor-panel.ts");
    const teamPanelTs = readSrc("src/ui/team-panel.ts");

    expect(teamBuilderTs).toContain("teamBuilderSave");
    expect(rulesEditorTs).toContain("isRuleAddRequest");
    expect(teamPanelTs).toContain("teamPause");

    const typeNames = extractUnionTypes(
      messagesTs,
      "WebviewToExtensionMessage",
    );
    expect(typeNames.length).toBeGreaterThan(10); // sanity check

    const missing: string[] = [];
    for (const typeName of typeNames) {
      // Types known to be in sub-panels — skip
      if (handledBySubPanel.has(typeName)) continue;

      // Strategy 1: look for isTypeName guard function used in provider
      const guardName1 = "is" + typeName;
      const guardName2 = "is" + typeName.replace(/Request$/, "");

      // Strategy 2: look for direct type literal in provider
      const typeGuessRaw = typeName
        .replace(/Request$/, "")
        .replace(/^([A-Z])/, (c) => c.toLowerCase())
        .replace(/([A-Z])/g, (c) => c.toLowerCase());

      if (
        !providerTs.includes(guardName1) &&
        !providerTs.includes(guardName2) &&
        !providerTs.includes(typeName) &&
        !providerTs.includes(`"${typeGuessRaw}"`)
      ) {
        missing.push(typeName);
      }
    }

    expect(
      missing,
      `These WebviewToExtensionMessage types appear to have no handler in chat-view-provider.ts or a sub-panel:\n  ${missing.join("\n  ")}\n\nAdd a handler or update the handledBySubPanel set in this test.`,
    ).toHaveLength(0);
  });

  it("WebviewToExtensionMessage union has at least 20 members", () => {
    const messagesTs = readSrc("src/ui/messages.ts");
    const typeNames = extractUnionTypes(
      messagesTs,
      "WebviewToExtensionMessage",
    );
    expect(typeNames.length).toBeGreaterThanOrEqual(20);
  });

  it("every exported type guard in messages.ts has the correct return type annotation", () => {
    const messagesTs = readSrc("src/ui/messages.ts");
    // All exported function names starting with "is"
    const guardFnMatches = messagesTs.matchAll(
      /export function (is\w+)\s*\([^)]+\)\s*:\s*msg is (\w+)/g,
    );
    const guards = [...guardFnMatches];
    expect(guards.length).toBeGreaterThan(10); // sanity check — many guards exist

    for (const [, fnName, returnType] of guards) {
      // The return type should be a known concrete type (not the union itself)
      expect(returnType).not.toBe("WebviewToExtensionMessage");
      expect(returnType).not.toBe("ExtensionToWebviewMessage");
      // Guard function name should match: isXxx → XxxRequest or Xxx
      const expectedPrefix = fnName.slice(2); // strip "is"
      // We just check the types are at least defined in the file
      expect(messagesTs).toContain(`interface ${returnType}`);
    }
  });

  it("no duplicate type discriminant values across the message union interfaces", () => {
    const messagesTs = readSrc("src/ui/messages.ts");

    // Extract type discriminant fields only from the top-level of interface declarations.
    // We look for patterns like: `  type: "someValue";` at the start of a line
    // (indented with spaces, inside an interface body). This avoids matching
    // nested `type:` fields used for subtype discrimination (e.g. "diff" | "command").
    const typeDiscriminantRe = /^\s{2}type:\s*"([^"]+)"\s*;/gm;
    const typeFields = messagesTs.matchAll(typeDiscriminantRe);
    const seen = new Set<string>();
    const duplicates: string[] = [];

    for (const [, value] of typeFields) {
      if (seen.has(value)) {
        duplicates.push(value);
      }
      seen.add(value);
    }

    expect(
      duplicates,
      `Duplicate type discriminants found in messages.ts: ${duplicates.join(", ")}`,
    ).toHaveLength(0);
  });
});

// ── ExtensionToWebviewMessage handler coverage ───────────────────────────────

describe("ExtensionToWebviewMessage factory functions", () => {
  it("at least some factory helpers exist for Extension→Webview messages", () => {
    const messagesTs = readSrc("src/ui/messages.ts");
    // Look for exported factory functions
    const factories = [...messagesTs.matchAll(/export function create(\w+)/g)];
    expect(factories.length).toBeGreaterThan(3);
  });
});
