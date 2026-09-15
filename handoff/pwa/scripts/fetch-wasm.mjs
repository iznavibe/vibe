/**
 * Fetch the prebuilt handoff wasm instead of building it.
 *
 * `chore phone-wasm` builds `handoff/wasm` from source, which needs the Rust
 * wasm toolchain, a wasm-bindgen CLI pinned to the crate's exact dependency,
 * and binaryen. Upstream CI builds it on Linux on purpose — the iroh client
 * pulls in `ring`, which compiles C for wasm32, and Apple clang has no wasm
 * target — so reproducing it locally on Windows or macOS is a project of its
 * own.
 *
 * Nothing in the on-device transcription path touches that crate: it is the
 * iroh client for talking to a desktop. So for work on the PWA itself, taking
 * the module upstream already published is the cheaper correct answer.
 *
 * The tradeoff, stated plainly: this pins you to whatever protocol version
 * upstream currently has deployed. Change the handoff wire format and you must
 * build the crate for real — this script cannot help you.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const SOURCE = process.env.WASM_SOURCE ?? 'https://thewh1teagle.github.io/vibe/phone/wasm'
const OUT = join(import.meta.dirname, '..', 'public', 'wasm')
const FILES = ['handoff_wasm.js', 'handoff_wasm_bg.wasm']

await mkdir(OUT, { recursive: true })

for (const name of FILES) {
	const url = `${SOURCE}/${name}`
	const res = await fetch(url)
	if (!res.ok) {
		console.error(`failed to fetch ${url}: ${res.status} ${res.statusText}`)
		process.exit(1)
	}
	const bytes = new Uint8Array(await res.arrayBuffer())

	// A 404 page served as 200 would land here as plausible-looking bytes and
	// only fail later, in the browser, as an opaque instantiation error.
	if (name.endsWith('.wasm')) {
		const magic = [0x00, 0x61, 0x73, 0x6d]
		if (!magic.every((b, i) => bytes[i] === b)) {
			console.error(`${name} is not a wasm module (bad magic bytes) — check WASM_SOURCE`)
			process.exit(1)
		}
		try {
			new WebAssembly.Module(bytes)
		} catch (err) {
			console.error(`${name} does not compile: ${err.message}`)
			process.exit(1)
		}
	}

	await writeFile(join(OUT, name), bytes)
	console.log(`${name}  ${(bytes.length / 1024).toFixed(0)} KiB`)
}

console.log(`wrote prebuilt bindings to public/wasm from ${SOURCE}`)
