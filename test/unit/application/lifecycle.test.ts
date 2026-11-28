import { describe, it, expect, vi } from "vitest";
import {
  LifecycleManager,
  type Lifecycle,
} from "../../../src/application/lifecycle";
import { ActivationContext } from "../../../src/application/activation-context";

describe("LifecycleManager", () => {
  it("registers subsystems and tracks registered subsystem names", () => {
    const manager = new LifecycleManager();
    const sub1: Lifecycle = {
      start: vi.fn(),
      dispose: vi.fn(),
    };
    const sub2 = {
      dispose: vi.fn(),
    };

    manager.register("sub1", sub1);
    manager.register("sub2", sub2);

    expect(manager.registeredSubsystems).toEqual(["sub1", "sub2"]);
    expect(manager.isStarted).toBe(false);
    expect(manager.isDisposed).toBe(false);
  });

  it("starts subsystems in registration order and is idempotent", async () => {
    const manager = new LifecycleManager();
    const order: string[] = [];

    const sub1: Lifecycle = {
      start: async () => {
        order.push("sub1:start");
      },
      dispose: vi.fn(),
    };

    const sub2: Lifecycle = {
      start: async () => {
        order.push("sub2:start");
      },
      dispose: vi.fn(),
    };

    manager.register("sub1", sub1);
    manager.register("sub2", sub2);

    await manager.start();
    expect(order).toEqual(["sub1:start", "sub2:start"]);
    expect(manager.isStarted).toBe(true);

    // Second start call does nothing
    await manager.start();
    expect(order).toEqual(["sub1:start", "sub2:start"]);
  });

  it("disposes subsystems in reverse order (LIFO)", async () => {
    const manager = new LifecycleManager();
    const order: string[] = [];

    const sub1: Lifecycle = {
      dispose: async () => {
        order.push("sub1:dispose");
      },
    };

    const sub2: Lifecycle = {
      dispose: async () => {
        order.push("sub2:dispose");
      },
    };

    const sub3 = {
      dispose: () => {
        order.push("sub3:dispose");
      },
    };

    manager.register("sub1", sub1);
    manager.register("sub2", sub2);
    manager.register("sub3", sub3);

    await manager.dispose();
    expect(order).toEqual(["sub3:dispose", "sub2:dispose", "sub1:dispose"]);
    expect(manager.isDisposed).toBe(true);
    expect(manager.isStarted).toBe(false);

    // Idempotent dispose
    await manager.dispose();
    expect(order).toEqual(["sub3:dispose", "sub2:dispose", "sub1:dispose"]);
  });

  it("handles disposables via addDisposable in reverse order", async () => {
    const manager = new LifecycleManager();
    const order: string[] = [];

    manager.addDisposable(
      {
        dispose: () => {
          order.push("disp1");
        },
      },
      {
        dispose: () => {
          order.push("disp2");
        },
      },
    );

    await manager.dispose();
    expect(order).toEqual(["disp2", "disp1"]);
  });

  it("immediately disposes disposables added after disposal", () => {
    const manager = new LifecycleManager();
    void manager.dispose();

    const disposed: string[] = [];
    manager.addDisposable({
      dispose: () => {
        disposed.push("late");
      },
    });

    expect(disposed).toEqual(["late"]);
  });

  it("throws when registering or starting after disposal", async () => {
    const manager = new LifecycleManager();
    await manager.dispose();

    expect(() => manager.register("foo", { dispose: () => undefined })).toThrow(
      "Cannot register subsystem 'foo' after LifecycleManager has been disposed",
    );

    await expect(manager.start()).rejects.toThrow(
      "Cannot start LifecycleManager after it has been disposed",
    );
  });

  it("aggregates errors if multiple subsystems fail during dispose", async () => {
    const manager = new LifecycleManager();
    const sub1 = {
      dispose: () => {
        throw new Error("Subsystem 1 failed");
      },
    };
    const sub2 = {
      dispose: () => {
        throw new Error("Subsystem 2 failed");
      },
    };
    const sub3 = {
      dispose: vi.fn(),
    };

    manager.register("sub1", sub1);
    manager.register("sub2", sub2);
    manager.register("sub3", sub3);

    await expect(manager.dispose()).rejects.toThrow(AggregateError);
    // sub3 was still disposed even though sub2 threw
    expect(sub3.dispose).toHaveBeenCalled();
  });

  it("rethrows single error if only one subsystem fails during dispose", async () => {
    const manager = new LifecycleManager();
    const sub1 = {
      dispose: () => {
        throw new Error("Single failure");
      },
    };
    manager.register("sub1", sub1);

    await expect(manager.dispose()).rejects.toThrow("Single failure");
  });
});

describe("ActivationContext", () => {
  it("registers and retrieves dependencies via service locator", () => {
    const ctx = new ActivationContext();
    const mockService = { doWork: () => "done" };

    ctx.register("workService", mockService);

    expect(ctx.has("workService")).toBe(true);
    expect(ctx.has("nonExistent")).toBe(false);
    expect(ctx.get("workService")).toBe(mockService);
    expect(ctx.require("workService")).toBe(mockService);
  });

  it("throws descriptive error when required service is missing", () => {
    const ctx = new ActivationContext();
    expect(() => ctx.require("missing")).toThrow(
      "Required service 'missing' not found in ActivationContext",
    );
  });

  it("automatically registers lifecycle-capable services with lifecycle manager", async () => {
    const ctx = new ActivationContext();
    const disposeFn = vi.fn();
    const startFn = vi.fn();

    ctx.register("subsystemA", {
      start: startFn,
      dispose: disposeFn,
    });

    expect(ctx.lifecycle.registeredSubsystems).toContain("subsystemA");

    await ctx.lifecycle.start();
    expect(startFn).toHaveBeenCalledTimes(1);

    await ctx.dispose();
    expect(disposeFn).toHaveBeenCalledTimes(1);
    expect(ctx.has("subsystemA")).toBe(false);
  });

  it("forwards subscriptions to vscode context and lifecycle manager", async () => {
    const subscriptions: { dispose: () => unknown }[] = [];
    const mockVsContext = {
      subscriptions,
    } as unknown as import("vscode").ExtensionContext;

    const ctx = new ActivationContext({
      vsContext: mockVsContext,
      workspaceRoot: "/test/workspace",
    });

    expect(ctx.workspaceRoot).toBe("/test/workspace");
    expect(ctx.vsContext).toBe(mockVsContext);

    const d1 = { dispose: vi.fn() };
    const d2 = { dispose: vi.fn() };

    ctx.subscribe(d1, d2);

    expect(mockVsContext.subscriptions).toContain(d1);
    expect(mockVsContext.subscriptions).toContain(d2);

    await ctx.dispose();
    expect(d1.dispose).toHaveBeenCalled();
    expect(d2.dispose).toHaveBeenCalled();
  });
});
