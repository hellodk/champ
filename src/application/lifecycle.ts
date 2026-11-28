/**
 * Contract for subsystems that have explicit startup and teardown phases.
 */
export interface Lifecycle {
  start?(): Promise<void> | void;
  dispose(): Promise<void> | void;
}

export interface SubsystemRegistration {
  name: string;
  instance: Lifecycle | { dispose(): unknown };
  started?: boolean;
}

/**
 * Manages the lifecycle of application subsystems and disposables.
 * Subsystems are started in registration order and disposed in reverse (LIFO) order.
 */
export class LifecycleManager {
  private subsystems: SubsystemRegistration[] = [];
  private disposables: { dispose(): unknown }[] = [];
  private _isStarted = false;
  private _isDisposed = false;

  get isStarted(): boolean {
    return this._isStarted;
  }

  get isDisposed(): boolean {
    return this._isDisposed;
  }

  get registeredSubsystems(): string[] {
    return this.subsystems.map((s) => s.name);
  }

  /**
   * Register a named subsystem that implements Lifecycle or has a dispose() method.
   */
  register(name: string, instance: Lifecycle | { dispose(): unknown }): this {
    if (this._isDisposed) {
      throw new Error(
        `Cannot register subsystem '${name}' after LifecycleManager has been disposed`,
      );
    }
    this.subsystems.push({ name, instance, started: false });
    return this;
  }

  /**
   * Track one or more disposables for automatic cleanup when LifecycleManager is disposed.
   */
  addDisposable(...disposables: { dispose(): unknown }[]): this {
    if (this._isDisposed) {
      for (const d of disposables) {
        try {
          d.dispose();
        } catch {
          // Ignore error on immediate cleanup if already disposed
        }
      }
      return this;
    }
    this.disposables.push(...disposables);
    return this;
  }

  /**
   * Start all registered subsystems that expose a start() method.
   */
  async start(): Promise<void> {
    if (this._isDisposed) {
      throw new Error(
        "Cannot start LifecycleManager after it has been disposed",
      );
    }
    if (this._isStarted) {
      return;
    }
    this._isStarted = true;

    for (const sub of this.subsystems) {
      if (
        "start" in sub.instance &&
        typeof sub.instance.start === "function" &&
        !sub.started
      ) {
        await sub.instance.start();
        sub.started = true;
      }
    }
  }

  /**
   * Dispose all registered subsystems in reverse order (LIFO), followed by any registered disposables.
   * Catches errors across all disposals and throws an aggregated error if any occur.
   */
  async dispose(): Promise<void> {
    if (this._isDisposed) {
      return;
    }
    this._isDisposed = true;
    this._isStarted = false;

    const errors: Error[] = [];

    // Dispose subsystems in reverse order (LIFO)
    const reversedSubsystems = [...this.subsystems].reverse();
    for (const sub of reversedSubsystems) {
      try {
        if (
          "dispose" in sub.instance &&
          typeof sub.instance.dispose === "function"
        ) {
          await sub.instance.dispose();
        }
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }
    this.subsystems = [];

    // Dispose any additional disposables in reverse order
    const reversedDisposables = [...this.disposables].reverse();
    for (const d of reversedDisposables) {
      try {
        await d.dispose();
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }
    this.disposables = [];

    if (errors.length > 0) {
      if (errors.length === 1) {
        throw errors[0];
      }
      throw new AggregateError(
        errors,
        `Errors occurred during lifecycle disposal:\n${errors.map((e) => e.message).join("\n")}`,
      );
    }
  }
}
