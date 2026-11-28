import type * as vscode from "vscode";
import { LifecycleManager, type Lifecycle } from "./lifecycle";

export interface ActivationContextOptions {
  vsContext?: vscode.ExtensionContext;
  workspaceRoot?: string;
  lifecycle?: LifecycleManager;
}

/**
 * Dependency injection container and activation context for the Champ application.
 * Manages service registration, resolution, extension subscriptions, and unified lifecycle.
 */
export class ActivationContext {
  public readonly lifecycle: LifecycleManager;
  public readonly vsContext?: vscode.ExtensionContext;
  public readonly workspaceRoot?: string;
  private readonly services = new Map<string, unknown>();

  constructor(options?: ActivationContextOptions) {
    this.vsContext = options?.vsContext;
    this.workspaceRoot = options?.workspaceRoot;
    this.lifecycle = options?.lifecycle ?? new LifecycleManager();
  }

  /**
   * Register a service by key.
   * If the service implements Lifecycle or has a dispose() method, it is automatically
   * registered with the LifecycleManager for graceful shutdown.
   */
  register<T>(key: string, instance: T): T {
    this.services.set(key, instance);
    if (
      instance &&
      (typeof instance === "object" || typeof instance === "function") &&
      ("dispose" in (instance as object) || "start" in (instance as object))
    ) {
      this.lifecycle.register(key, instance as unknown as Lifecycle);
    }
    return instance;
  }

  /**
   * Retrieve a registered service by key, or undefined if not registered.
   */
  get<T>(key: string): T | undefined {
    return this.services.get(key) as T | undefined;
  }

  /**
   * Retrieve a registered service by key, throwing an Error if not found.
   */
  require<T>(key: string): T {
    const service = this.get<T>(key);
    if (service === undefined) {
      throw new Error(
        `Required service '${key}' not found in ActivationContext`,
      );
    }
    return service;
  }

  /**
   * Check if a service is registered.
   */
  has(key: string): boolean {
    return this.services.has(key);
  }

  /**
   * Track one or more disposables across both VS Code's context subscriptions
   * and the internal LifecycleManager.
   */
  subscribe(...disposables: { dispose(): unknown }[]): void {
    if (this.vsContext) {
      this.vsContext.subscriptions.push(
        ...(disposables as vscode.Disposable[]),
      );
    }
    this.lifecycle.addDisposable(...disposables);
  }

  /**
   * Gracefully dispose all registered services and managed resources.
   */
  async dispose(): Promise<void> {
    this.services.clear();
    await this.lifecycle.dispose();
  }
}
