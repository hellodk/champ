// Redirect abort-controller imports to Node 20 built-in globals.
module.exports = { AbortController: globalThis.AbortController, AbortSignal: globalThis.AbortSignal };
module.exports.AbortController = globalThis.AbortController;
module.exports.AbortSignal = globalThis.AbortSignal;
module.exports.default = globalThis.AbortController;
