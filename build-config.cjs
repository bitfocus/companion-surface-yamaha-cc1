// serialport loads its native binding at runtime through node-gyp-build, which resolves
// paths relative to its own package and does not survive esbuild bundling — bundled, it
// misdetects the runtime and fails to find any prebuild. Keeping it external means the
// packager installs it into the output package with its resolution intact, prebuilds
// and all.
module.exports = {
	externals: ['serialport'],
}
