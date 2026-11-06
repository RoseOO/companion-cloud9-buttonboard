module.exports = {
  // node-hid ships prebuilt binaries; let the Companion packager include them.
  prebuilds: ['node-hid'],
  forceRemoveNodeGypFromPkg: true,
}
