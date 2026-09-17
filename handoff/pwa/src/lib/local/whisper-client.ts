/**
 * whisper.cpp, driven from the main thread.
 *
 * This is deliberately *not* a worker, which is the opposite of the ONNX path
 * and needs explaining.
 *
 * whisper.cpp's wasm gets its speed from pthreads — roughly 4x — and Emscripten
 * creates that thread pool from wherever the runtime is initialised. Initialise
 * it inside a worker of our own and `initWhisper` never returns: it hangs the
 * same way for a 74 MB model as for a 547 MB one, so it is the nesting and not
 * the size. Nested workers spawning pthreads is a road that does not go
 * anywhere.
 *
 * So the package keeps its own worker (`worker: true`) and this module talks to
 * it from the main thread. The heavy work still happens off the UI thread — it
 * is simply the package's thread rather than one of ours.
 */

import { createProgressTracker } from './progress'

const MODEL_CACHE = 'whisper-ggml'

/** Where `scripts/copy-whisper.mjs` put the runtime — the app root. */
const RUNTIME_BASE = new URL(import.meta.env.BASE_URL, window.location.origin).href

export interface WhisperEvents {
	onDownload(pct: number, cached: boolean): void
	onReady(): void
	onProgress(pct: number): void
}

export interface WhisperRun {
	text: string
	chunks: { start: number; stop: number; text: string }[]
	elapsedSec: number
}

type WhisperModule = {
	configureWasm(options: Record<string, unknown>): void
	loadWhisperModule(): Promise<unknown>
	initWhisper(options: Record<string, unknown>): Promise<WhisperContext>
	isWasmThreadsSupported(): boolean
}

interface WhisperContext {
	transcribeData(pcm: Float32Array, options: Record<string, unknown>): { promise?: Promise<WhisperResult> } | Promise<WhisperResult>
}

interface WhisperResult {
	result?: string
	segments?: { t0?: number; t1?: number; text?: string }[]
}

let modulePromise: Promise<WhisperModule> | null = null
let loaded: { url: string; ctx: WhisperContext } | null = null

/**
 * Load the runtime once.
 *
 * `configureWasm` throws once the runtime is up and a failed attempt leaves it
 * half-initialised, so this is a one-shot promise rather than something that
 * retries in place. Recovery means reloading the page, which `resetWhisper`
 * cannot do — hence the deliberate lack of a retry path here.
 */
async function getModule(): Promise<WhisperModule> {
	if (modulePromise) return modulePromise

	modulePromise = (async () => {
		const mod = (await import(/* @vite-ignore */ `${RUNTIME_BASE}index.js`)) as WhisperModule

		// Threads need cross-origin isolation, which the service worker
		// synthesises. Where that failed the plain build still runs, ~4x slower,
		// rather than not at all.
		const threads = typeof SharedArrayBuffer !== 'undefined' && mod.isWasmThreadsSupported()

		/*
			Only `threads` is set. No `jsPath`, `wasmPath` or `locateFileBaseUrl`.

			The package derives those from its own module URL, and Emscripten
			resolves the pthread worker script the same way. Overriding them loads
			the runtime successfully and then hangs forever inside `initWhisper`,
			waiting on a thread pool whose workers never start — with no error
			anywhere. `scripts/copy-whisper.mjs` preserves the package's layout at
			the app root precisely so these can be left alone.
		*/
		mod.configureWasm({
			threads,
			// Inline, on this thread. Our own worker hangs (nested pthreads), and
			// so does the package's own worker. This is the only configuration
			// that completes. The cost is a blocked UI during the run.
			worker: false,
		})
		await mod.loadWhisperModule()
		return mod
	})().catch((err) => {
		modulePromise = null
		throw err
	})

	return modulePromise
}

/**
 * Put the weights in the package's cache ourselves.
 *
 * Its own fetch stalls indefinitely on files this size — a 547 MB model sat at
 * zero bytes for nine minutes, while a streaming read of the same URL finishes
 * in about a minute. Its cache key is simply the source URL, so priming the
 * cache makes its loader take the fast path. This is also the only way to
 * report download progress at all.
 */
async function ensureCached(url: string, events: WhisperEvents): Promise<void> {
	const cache = await caches.open(MODEL_CACHE)
	if (await cache.match(url)) {
		events.onDownload(100, true)
		return
	}

	const res = await fetch(url)
	if (!res.ok) throw new Error(`Could not download the model (HTTP ${res.status}).`)

	const total = Number(res.headers.get('content-length')) || 0
	const reader = res.body?.getReader()
	if (!reader) throw new Error('This browser cannot stream the model download.')

	const chunks: Uint8Array[] = []
	let loadedBytes = 0
	for (;;) {
		const { done, value } = await reader.read()
		if (done) break
		chunks.push(value)
		loadedBytes += value.byteLength
		if (total > 0) events.onDownload(Math.min(99, Math.round((loadedBytes / total) * 100)), false)
	}

	const bytes = new Uint8Array(loadedBytes)
	let offset = 0
	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.byteLength
	}
	await cache.put(url, new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } }))
}

/** Threads to ask for, leaving the device something to run the UI with. */
function threadCount(): number {
	return Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1))
}

export async function runWhisper(opts: { modelUrl: string; pcm: Float32Array; lang: string | null }, events: WhisperEvents): Promise<WhisperRun> {
	const mod = await getModule()
	await ensureCached(opts.modelUrl, events)

	// Reuse a loaded context across runs: re-reading half a gigabyte per
	// recording would dominate everything else.
	if (loaded?.url !== opts.modelUrl) {
		loaded = {
			url: opts.modelUrl,
			// `filePath` wins over `modelUrl` inside the package, so the URL goes
			// there or it fetches a relative path and 404s.
			ctx: await mod.initWhisper({ filePath: opts.modelUrl, cacheModel: true, modelCacheName: MODEL_CACHE, useGpu: false }),
		}
	}
	events.onReady()

	// whisper.cpp reports progress over the whole run, so unlike the ONNX path
	// there are no window-relative offsets to repair. The tracker is kept for
	// its monotonic clamp and ceiling.
	const progress = createProgressTracker(100)
	const startedAt = performance.now()

	// `transcribeData` takes samples; `transcribe` takes a URL and would try to
	// fetch the Float32Array stringified, failing as an opaque network error.
	const call = loaded.ctx.transcribeData(opts.pcm, {
		language: opts.lang ?? undefined,
		maxThreads: threadCount(),
		onProgress: (pct: number) => events.onProgress(progress.push(pct)),
	})
	const result = await ((call as { promise?: Promise<WhisperResult> })?.promise ?? (call as Promise<WhisperResult>))

	const chunks = (result?.segments ?? []).map((s) => ({
		// whisper.cpp timestamps are centiseconds.
		start: (s.t0 ?? 0) / 100,
		stop: (s.t1 ?? s.t0 ?? 0) / 100,
		text: s.text ?? '',
	}))

	return {
		text: (result?.result ?? chunks.map((c) => c.text).join(' ')).trim(),
		chunks,
		elapsedSec: (performance.now() - startedAt) / 1000,
	}
}

/** Drop the loaded model so a different one can be selected. */
export function resetWhisper(): void {
	loaded = null
}
