// Redirect formdata-node imports to Node 20 built-in globals.
// Lazy getters prevent load-time crashes when globals aren't ready yet.

Object.defineProperty(module.exports, "FormData", { get: () => globalThis.FormData, enumerable: true });
Object.defineProperty(module.exports, "Blob", { get: () => globalThis.Blob, enumerable: true });
Object.defineProperty(module.exports, "File", { get: () => globalThis.File, enumerable: true });

module.exports.fileFromPath = async (filePath, fileName, options) => {
  const fs = require("fs");
  const pathMod = require("path");
  const FileClass = globalThis.File;
  if (!FileClass) throw new TypeError("[champ-shim] globalThis.File is not defined.");
  const buf = fs.readFileSync(filePath);
  return new FileClass([buf], fileName ?? pathMod.basename(filePath), options);
};
