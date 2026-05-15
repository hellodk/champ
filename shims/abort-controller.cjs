// Redirect abort-controller imports to Node 20 built-in globals.
// Lazy getters prevent load-time crashes when globals aren't ready yet.

Object.defineProperty(module.exports, "AbortController", { get: () => globalThis.AbortController, enumerable: true });
Object.defineProperty(module.exports, "AbortSignal", { get: () => globalThis.AbortSignal, enumerable: true });
Object.defineProperty(module.exports, "default", { get: () => globalThis.AbortController, enumerable: true });
