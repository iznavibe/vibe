/**
 * Copy ONNX Runtime's wasm binaries into `public/ort/`.
 *
 * transformers.js, left alone, points ORT at the jsDelivr CDN — it sets
 * `wasmPaths` to `cdn.jsdelivr.net/npm/onnxruntime-web@<version>/dist/...` when
 * the app has not set them. That is fatal here for two separate reasons:
 *
 *   1. Offline. The service worker only caches same-origin requests, so the
 *      runtime would be fetched from the network on every cold start and the
 *      whole point of on-device transcription would evaporate in airplane mode.
 *   2. Version drift. The CDN copy tracks whatever version the installed
 *      package reports, which is not necessarily the one this build resolved.
 *
 * Both binaries are copied because the right one depends on the backend, and
 * the backend depends on the browser (see `backend.ts`). A visitor downloads
 * only the one their backend asks for.
 */
import { copyFile, mkdir, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

// Resolved *through* transformers.js rather than from here: onnxruntime-web is
// its dependency, not ours, and under pnpm's strict layout it is not reachable
// from this package at all. Going through the owner also guarantees the copy is
// the exact build this install resolved, which is the whole point.
const require = createRequire(import.meta.url)
// The package does not export `./package.json`, so resolve its entry point and
// use that as the base to resolve from.
const fromTransformers = createRequire(require.resolve('@huggingface/transformers'))
const ortDist = dirname(fromTransformers.resolve('onnxruntime-web'))
const OUT = join(import.meta.dirname, '..', 'public', 'ort')

/**
 * The plain build is what Safari and every iOS browser use: ORT's WebGPU
 * execution provider is JSEP, and JSEP on WebKit 26 pins the content process
 * and gets it killed (onnxruntime#26827). The asyncify build carries JSEP for
 * the browsers where it works.
 */
const NEEDED = ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.asyncify.wasm', 'ort-wasm-simd-threaded.asyncify.mjs']

await mkdir(OUT, { recursive: true })
const available = new Set(await readdir(ortDist))

for (const name of NEEDED) {
	if (!available.has(name)) {
		console.error(`onnxruntime-web no longer ships ${name} — check what replaced it before shipping a build that 404s offline.`)
		process.exit(1)
	}
	await copyFile(join(ortDist, name), join(OUT, name))
	console.log(`ort/${name}`)
}

console.log(`copied ${NEEDED.length} files from ${ortDist}`)
