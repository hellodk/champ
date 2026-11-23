import { describe, expect, it } from "vitest";
import * as os from "os";
import * as path from "path";
import { EndpointRepository } from "@/config/provider-repository";
import { champConfigDir, champHome } from "@/config/home";

describe("CHAMP_HOME", () => {
  it("resolves the user home from the override when present", () => {
    expect(champHome({ CHAMP_HOME: "/tmp/champ-home" })).toBe(
      path.resolve("/tmp/champ-home"),
    );
  });

  it("falls back to os.homedir() when the override is absent or blank", () => {
    expect(champHome({})).toBe(os.homedir());
    expect(champHome({ CHAMP_HOME: "   " })).toBe(os.homedir());
  });

  it("places the canonical .champ directory under the overridden home", () => {
    expect(champConfigDir({ CHAMP_HOME: "/tmp/champ-home" })).toBe(
      path.join(path.resolve("/tmp/champ-home"), ".champ"),
    );
  });

  it("makes EndpointRepository use the override when no homeDir is supplied", () => {
    const previous = process.env.CHAMP_HOME;
    process.env.CHAMP_HOME = "/tmp/champ-home";
    try {
      expect(new EndpointRepository().path()).toBe(
        path.join(path.resolve("/tmp/champ-home"), ".champ", "providers.json"),
      );
    } finally {
      if (previous === undefined) delete process.env.CHAMP_HOME;
      else process.env.CHAMP_HOME = previous;
    }
  });
});
