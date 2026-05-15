// Redirect node-fetch imports to Node 20's built-in fetch globals.
// VS Code's extension host runs Node 20+ which has fetch as a global.
// This shim lets the Anthropic and OpenAI SDKs find their polyfill
// import without bundling the 400KB node-fetch + tr46 + whatwg-url stack.
const f = globalThis.fetch.bind(globalThis);
module.exports = f;
module.exports.default = f;
module.exports.Headers = globalThis.Headers;
module.exports.Request = globalThis.Request;
module.exports.Response = globalThis.Response;
module.exports.FormData = globalThis.FormData;
module.exports.AbortController = globalThis.AbortController;
