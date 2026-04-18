// Preload bridge. Exposes fs and path to the renderer via contextBridge so the
// renderer can read/write flows.json directly. Also exposes a small env object
// (GEMINI_API_KEY, MCP_SERVER_URL, TARGET_URL) so the renderer can configure
// itself without process.env.

const { contextBridge } = require('electron');
const fs = require('fs');
const path = require('path');

contextBridge.exposeInMainWorld('nodeApi', {
  fs: {
    readFileSync: (p, enc) => fs.readFileSync(p, enc),
    writeFileSync: (p, data, enc) => fs.writeFileSync(p, data, enc),
    existsSync: (p) => fs.existsSync(p),
    watch: (p, cb) => fs.watch(p, cb)
  },
  path: {
    resolve: (...args) => path.resolve(...args),
    join: (...args) => path.join(...args)
  },
  // The renderer's __dirname when computed from this preload's location -
  // useFlows resolves '../../flows/flows.json' from this dirname.
  dirname: path.resolve(__dirname, 'renderer')
});

contextBridge.exposeInMainWorld('appEnv', {
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  MCP_SERVER_URL: process.env.MCP_SERVER_URL || 'http://localhost:8931',
  TARGET_URL: process.env.TARGET_URL || 'http://localhost:3000'
});
