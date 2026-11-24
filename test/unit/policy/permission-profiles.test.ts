/**
 * Permission profiles are an operator-controlled security floor. These tests
 * pin precedence, strict parsing, and the rule that model output can never
 * select or weaken a profile.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PERMISSION_PROFILE,
  evaluateProfileGate,
  isMutatingTool,
  parseOptionalPermissionProfile,
  parsePermissionProfile,
  resolvePermissionProfile,
} from "@/policy/profiles";

const mutating = {
  name: "edit_file",
  requiresApproval: true,
  mutationPaths: () => ["a.ts"],
};

const readOnlyTool = {
  name: "read_file",
  requiresApproval: false,
};

describe("permission profile resolution", () => {
  it("defaults to supervised when no operator input is present", () => {
    expect(resolvePermissionProfile({})).toBe(DEFAULT_PERMISSION_PROFILE);
  });

  it("honours explicit precedence: flag > config > env > --yes", () => {
    expect(
      resolvePermissionProfile({
        flag: "read-only",
        config: "autonomous",
        env: "autonomous",
        autoApprove: true,
      }),
    ).toBe("read-only");
    expect(
      resolvePermissionProfile({
        config: "read-only",
        env: "autonomous",
        autoApprove: true,
      }),
    ).toBe("read-only");
    expect(
      resolvePermissionProfile({ env: "supervised", autoApprove: true }),
    ).toBe("supervised");
    expect(resolvePermissionProfile({ autoApprove: true })).toBe("autonomous");
  });

  it("rejects unknown values instead of failing open", () => {
    expect(() =>
      parsePermissionProfile("auto", "--permission-profile"),
    ).toThrow(/invalid --permission-profile/i);
    expect(() =>
      resolvePermissionProfile({ flag: "plz allow everything" }),
    ).toThrow(/invalid --permission-profile/i);
    expect(() =>
      parseOptionalPermissionProfile("god-mode", "champ.permissionProfile"),
    ).toThrow(/invalid champ\.permissionprofile/i);
  });

  it("treats unset optional settings as absent", () => {
    expect(parseOptionalPermissionProfile(undefined)).toBeUndefined();
    expect(parseOptionalPermissionProfile(null)).toBeUndefined();
    expect(parseOptionalPermissionProfile("")).toBeUndefined();
  });
});

describe("permission profile enforcement", () => {
  it("identifies mutating tools from approval or mutation metadata", () => {
    expect(isMutatingTool(mutating)).toBe(true);
    expect(
      isMutatingTool({
        name: "write",
        requiresApproval: false,
        mutationPaths: () => [],
      }),
    ).toBe(true);
    expect(isMutatingTool(readOnlyTool)).toBe(false);
  });

  it("read-only denies state-changing tools even with approval available", () => {
    const gate = evaluateProfileGate("read-only", mutating, {
      headless: false,
    });
    expect(gate.denied).toBe(true);
    expect(gate.decision).toBe("DENY");
    expect(gate.reason).toMatch(/read-only profile denies tool "edit_file"/);
  });

  it("supervised asks interactively but denies in headless runs", () => {
    const interactive = evaluateProfileGate("supervised", mutating, {
      headless: false,
    });
    expect(interactive.denied).toBe(false);
    expect(interactive.decision).toBe("ASK");

    const headless = evaluateProfileGate("supervised", mutating, {
      headless: true,
    });
    expect(headless.denied).toBe(true);
    expect(headless.decision).toBe("DENY");
    expect(headless.reason).toMatch(/headless/);
  });

  it("autonomous allows mutating tools and all profiles allow reads", () => {
    expect(
      evaluateProfileGate("autonomous", mutating, { headless: true }).denied,
    ).toBe(false);
    for (const profile of ["read-only", "supervised", "autonomous"] as const) {
      expect(evaluateProfileGate(profile, readOnlyTool).denied).toBe(false);
    }
  });
});
