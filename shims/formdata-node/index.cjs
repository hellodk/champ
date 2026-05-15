// Redirect formdata-node imports to Node 20 built-in globals.
const FormData = globalThis.FormData;
const Blob = globalThis.Blob;
const File = globalThis.File;

module.exports = { FormData, Blob, File };
module.exports.FormData = FormData;
module.exports.Blob = Blob;
module.exports.File = File;
module.exports.fileFromPath = async (path, name, options) => {
  const fs = require('fs');
  const buf = fs.readFileSync(path);
  return new File([buf], name ?? require('path').basename(path), options);
};
