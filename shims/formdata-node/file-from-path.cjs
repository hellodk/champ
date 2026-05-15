// Shim for formdata-node/file-from-path using Node 20 built-in File + fs.
// Uses lazy access to globalThis.File to avoid load-time crashes.
const fs = require("fs");
const path = require("path");

async function fileFromPath(filePath, fileName, options) {
  const FileClass = globalThis.File;
  if (!FileClass) throw new TypeError("[champ-shim] globalThis.File is not defined.");
  const buf = fs.readFileSync(filePath);
  return new FileClass([buf], fileName ?? path.basename(filePath), options);
}

module.exports = { fileFromPath };
module.exports.fileFromPath = fileFromPath;
