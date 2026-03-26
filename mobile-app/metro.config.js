const { getDefaultConfig } = require("expo/metro-config");
const exclusionList = require("metro-config/src/defaults/exclusionList");
const path = require("path");

const config = getDefaultConfig(__dirname);

// Keep Metro scoped to this app only to prevent EMFILE in large monorepos.
config.projectRoot = __dirname;
config.watchFolders = [__dirname];
config.resolver.nodeModulesPaths = [path.resolve(__dirname, "node_modules")];
config.resolver.blockList = exclusionList([
  /.*\/backend\/.*/,
  /.*\/frontend\/.*/,
  /.*\/persistent\/.*/,
  /.*\/manual_requests\/.*/,
  /.*\/models\/.*/,
]);

module.exports = config;
