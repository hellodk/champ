// Shim for formdata-node/file-from-path using Node 20 built-in File + fs.
const fs = require('fs');
const path = require('path');
async function fileFromPath(filePath, fileName, options) {
  const buf = fs.readFileSync(filePath);
  return new globalThis.File([buf], fileName ?? path.basename(filePath), options);
}
module.exports = { fileFromPath };
module.exports.fileFromPath = fileFromPath;
