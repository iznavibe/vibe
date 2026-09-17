/**
 * Copy whisper.cpp's wasm runtime into `public/whisper/`.
 *
 * Same reasoning as `copy-ort.mjs`: the runtime must come from this origin so
 * the service worker can cache it, or on-device transcription dies the moment
 * the network does.
 *
 * Both builds are copied. The threaded one is the only one worth using — it
 * measured ~4.2x faster than single-threaded — but it needs cross-origin
 * isolation, and a browser that does not have it falls back to the plain build
 * rather than failing.
 *
 * `index.js` is copied to the root of `public/whisper/` under its own name
 * because the package resolves its sibling paths relative to itself; renaming
 * it makes the pthread workers 404 with an error that looks like a network
 * problem and is not.
 */
import { copyFile, mkdir, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

// Resolved through `@fugood/whisper.node`, which owns it: under pnpm's strict
// layout the wasm package is not reachable from here directly.
const require = createRequire(import.meta.url)
const fromWrapper = createRequire(require.resolve('@fugood/whisper.node'))
const pkgDir = dirname(fromWrapper.resolve('@fugood/node-whisper-wasm'))
/*
	The runtime lands at the app root, not in a subdirectory.

	The package derives its sibling paths from its own module URL — `wasm/…`
	beside it, `worker.js` next to it — and Emscripten resolves the pthread
	worker script the same way. Overriding those with explicit `jsPath` /
	`wasmPath` / `locateFileBaseUrl` loads the runtime fine and then hangs
	forever inside `initWhisper`, waiting on a thread pool whose workers never
	start. Leaving the layout alone is what works.
*/
const OUT = join(import.meta.dirname, '..', 'public')

const ROOT_FILES = ['index.js', 'worker.js']
const WASM_FILES = ['whisper-node.js', 'whisper-node.wasm', 'whisper-node.threads.js', 'whisper-node.threads.wasm']

await mkdir(join(OUT, 'wasm'), { recursive: true })

const rootAvailable = new Set(await readdir(pkgDir))
for (const name of ROOT_FILES) {
	if (!rootAvailable.has(name)) {
		console.error(`@fugood/node-whisper-wasm no longer ships ${name} — the runtime layout changed.`)
		process.exit(1)
	}
	await copyFile(join(pkgDir, name), join(OUT, name))
	console.log(name)
}

const wasmAvailable = new Set(await readdir(join(pkgDir, 'wasm')))
for (const name of WASM_FILES) {
	if (!wasmAvailable.has(name)) {
		console.error(`@fugood/node-whisper-wasm no longer ships wasm/${name} — check what replaced it.`)
		process.exit(1)
	}
	await copyFile(join(pkgDir, 'wasm', name), join(OUT, 'wasm', name))
	console.log(`wasm/${name}`)
}

console.log(`copied ${ROOT_FILES.length + WASM_FILES.length} files from ${pkgDir}`)
