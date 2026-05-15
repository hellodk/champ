// Redirect node-fetch imports to Node 20's built-in fetch globals.
// VS Code's extension host runs Node 20+ which has fetch as a global.
// This shim lets the Anthropic and OpenAI SDKs find their polyfill
// import without bundling the 400KB node-fetch + tr46 + whatwg-url stack.
// Lazy getters avoid load-time crashes when globalThis.fetch is not yet
// available at module evaluation time (e.g. VS Code extension host startup).

function getGlobal(name) {
  const val = globalThis[name];
  if (typeof val === "undefined") {
    throw new TypeError(
      `[champ-shim] globalThis.${name} is not defined. ` +
      `The extension host must run Node 20+ with built-in fetch.`
    );
  }
  return val;
}

const handler = {
  get(target, prop) {
    if (prop === "default") return (...args) => getGlobal("fetch")(...args);
    if (prop === "Headers") return getGlobal("Headers");
    if (prop === "Request") return getGlobal("Request");
    if (prop === "Response") return getGlobal("Response");
    if (prop === "FormData") return getGlobal("FormData");
    if (prop === "AbortController") return getGlobal("AbortController");
    return target[prop];
  },
};

const fetchShim = new Proxy(function fetch(...args) {
  return getGlobal("fetch")(...args);
}, handler);

module.exports = fetchShim;
module.exports.default = fetchShim;

Object.defineProperty(module.exports, "Headers", { get: () => getGlobal("Headers"), enumerable: true });
Object.defineProperty(module.exports, "Request", { get: () => getGlobal("Request"), enumerable: true });
Object.defineProperty(module.exports, "Response", { get: () => getGlobal("Response"), enumerable: true });
Object.defineProperty(module.exports, "FormData", { get: () => getGlobal("FormData"), enumerable: true });
Object.defineProperty(module.exports, "AbortController", { get: () => getGlobal("AbortController"), enumerable: true });
