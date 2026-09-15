/// <reference lib="webworker" />
/**
 * On-device transcription, off the main thread.
 *
 * This is the phone's answer to `vibe-server`. The desktop spawns a sidecar
 * process and talks to it over HTTP; a browser tab cannot spawn anything, so
 * the equivalent isolation is a worker. It matters for the same reason the
 * sidecar does: loading a few hundred megabytes of weights and then running
 * them blocks whatever thread it happens to be on, and on the main thread that
 * is a frozen UI and a phone that looks crashed.
 *
 * The engine is not Vibe's. The desktop runs whisper.cpp through `whisper-rs`
 * against GGML weights; there is no usable WebGPU path for GGML in a browser,
 * so on-device runs ONNX Runtime Web via transformers.js instead. Same model
 * family, same audio contract, different runtime — which is why a phone
 * transcript and a desktop transcript of the same recording will differ
 * slightly even when both say "large-v3-turbo".
 */

import { pipeline, WhisperTextStreamer, env, type AutomaticSpeechRecognitionPipeline, type DataType } from '@huggingface/transformers'

import { createProgressTracker } from './progress'
import type { Backend } from './backend'

/**
 * Whether this repo's files are already in the browser cache.
 *
 * Duplicated from `models.ts` rather than imported because that module pulls in
 * `localStorage` helpers a worker has no business touching, and the check is
 * three lines. Advisory either way: a miss means "could not confirm".
 */
async function isRepoCached(repo: string): Promise<boolean> {
	try {
		if (typeof caches === 'undefined') return false
		const cache = await caches.open('transformers-cache')
		const keys = await cache.keys()
		const prefix = repo.toLowerCase()
		return keys.some((req) => req.url.toLowerCase().includes(prefix))
	} catch {
		return false
	}
}

/**
 * The streamer is typed against `WhisperTokenizer`, but a pipeline exposes its
 * tokenizer as the base `PreTrainedTokenizer`. Loading a Whisper repo always
 * yields the Whisper subclass, so this narrows what the types cannot.
 */
type WhisperTokenizerLike = ConstructorParameters<typeof WhisperTextStreamer>[0]

// Weights come from the Hugging Face CDN and are cached by the browser. There
// is no local model directory to look in, and leaving this on makes
// transformers.js probe for one on every load and log a 404 for its trouble.
env.allowLocalModels = false

/**
 * Serve ONNX Runtime's wasm from this origin, not jsDelivr.
 *
 * Left unset, transformers.js points `wasmPaths` at
 * `cdn.jsdelivr.net/npm/onnxruntime-web@<version>/dist/`. The service worker
 * only caches same-origin requests, so the runtime would come off the network
 * on every cold start and on-device transcription would fail in exactly the
 * situation it exists for. `scripts/copy-ort.mjs` puts these in `public/ort/`.
 *
 * Which binary matters: the asyncify build carries JSEP, ORT's WebGPU
 * execution provider, and the plain one does not. They are not interchangeable
 * — asking for a `webgpu` session against the plain binary fails — so the file
 * is chosen from the backend, in one place, rather than inferred twice.
 */
function configureOrtPaths(backend: Backend) {
	// Resolved against the deploy base, NOT `self.location`: this module is
	// served from `assets/worker-<hash>.js`, so resolving relatively would look
	// for `assets/ort/...` and 404. BASE_URL is `/` in dev and `/vibe/` on
	// Pages, and always carries its trailing slash.
	const base = new URL(`${import.meta.env.BASE_URL}ort/`, self.location.origin).href
	const stem = backend === 'webgpu' ? 'ort-wasm-simd-threaded.asyncify' : 'ort-wasm-simd-threaded'
	const wasm = env.backends?.onnx?.wasm
	if (!wasm) return
	wasm.wasmPaths = { mjs: `${base}${stem}.mjs`, wasm: `${base}${stem}.wasm` }
}

export interface TranscribeRequest {
	type: 'transcribe'
	id: string
	repo: string
	backend: Backend
	dtype: Record<string, DataType>
	/** ISO code, or null to let Whisper detect it. */
	lang: string | null
	pcm: Float32Array
	durationSec: number
}

export interface PreloadRequest {
	type: 'preload'
	id: string
	repo: string
	backend: Backend
	dtype: Record<string, DataType>
}

export type WorkerRequest = TranscribeRequest | PreloadRequest

export type WorkerReply =
	/**
	 * Weights being read in. `cached` distinguishes a first download from a
	 * read out of the browser cache: transformers.js reports progress
	 * identically for both, so without this the UI claims to be downloading a
	 * model the user already has.
	 */
	| { type: 'download'; id: string; pct: number; loaded: number; total: number; cached: boolean }
	/** Weights are in memory and warm. */
	| { type: 'ready'; id: string }
	| { type: 'progress'; id: string; pct: number }
	/** Text as it is decoded, for the live view. Superseded by `done`. */
	| { type: 'partial'; id: string; text: string }
	| { type: 'done'; id: string; text: string; chunks: { start: number; stop: number; text: string }[]; elapsedSec: number }
	| { type: 'error'; id: string; message: string }

const ctx = self as unknown as DedicatedWorkerGlobalScope

function post(reply: WorkerReply) {
	ctx.postMessage(reply)
}

/**
 * One loaded pipeline, keyed by what it was loaded with.
 *
 * Kept across requests on purpose: re-reading several hundred megabytes from
 * the cache and re-initialising the WebGPU session costs tens of seconds, and
 * transcribing a queue of three recordings should pay that once. Switching
 * model drops the old one, because two large sessions resident at the same
 * time is how a phone tab gets killed.
 */
let loaded: { key: string; pipe: AutomaticSpeechRecognitionPipeline } | null = null

/** Track bytes per file so the reported percentage is over the whole download. */
type FileProgress = { loaded: number; total: number }

async function getPipeline(id: string, repo: string, backend: Backend, dtype: Record<string, DataType>): Promise<AutomaticSpeechRecognitionPipeline> {
	const key = `${repo}:${backend}:${JSON.stringify(dtype)}`
	if (loaded?.key === key) return loaded.pipe

	if (loaded) {
		// Free the old session before asking for a new one, not after.
		try {
			await loaded.pipe.dispose()
		} catch {
			// A failed dispose is not worth aborting the load for.
		}
		loaded = null
	}

	configureOrtPaths(backend)

	const files = new Map<string, FileProgress>()

	// Asked once, before loading starts: mid-load the cache is being written to,
	// so the answer would change under us.
	const cached = await isRepoCached(repo)

	const pipe = (await pipeline('automatic-speech-recognition', repo, {
		// Never hardcoded to webgpu — see backend.ts. On WebKit that path kills
		// the process outright.
		device: backend,
		dtype,
		progress_callback: (event: unknown) => {
			const e = event as { status?: string; file?: string; loaded?: number; total?: number }
			if (e.status !== 'progress' || !e.file || !e.total) return
			files.set(e.file, { loaded: e.loaded ?? 0, total: e.total })

			let loadedBytes = 0
			let totalBytes = 0
			for (const f of files.values()) {
				loadedBytes += f.loaded
				totalBytes += f.total
			}
			if (totalBytes > 0) {
				post({
					type: 'download',
					id,
					pct: Math.min(100, Math.round((loadedBytes / totalBytes) * 100)),
					loaded: loadedBytes,
					total: totalBytes,
					cached,
				})
			}
		},
	})) as AutomaticSpeechRecognitionPipeline

	loaded = { key, pipe }
	return pipe
}

async function transcribe(req: TranscribeRequest) {
	const pipe = await getPipeline(req.id, req.repo, req.backend, req.dtype)
	post({ type: 'ready', id: req.id })

	const startedAt = performance.now()
	let partial = ''

	// Window-relative offsets, made absolute and monotonic. See progress.ts.
	const progress = createProgressTracker(req.durationSec)

	const streamer = new WhisperTextStreamer(pipe.tokenizer as unknown as WhisperTokenizerLike, {
		skip_prompt: true,
		on_chunk_start: (offsetSec: number) => {
			post({ type: 'progress', id: req.id, pct: progress.push(offsetSec) })
		},
		callback_function: (text: string) => {
			partial += text
			post({ type: 'partial', id: req.id, text: partial })
		},
	})

	const out = await pipe(req.pcm, {
		// 30 s is Whisper's native window; the overlap lets the pipeline stitch
		// across boundaries instead of clipping a word in half at each seam.
		chunk_length_s: 30,
		stride_length_s: 5,
		return_timestamps: true,
		language: req.lang ?? undefined,
		task: 'transcribe',
		streamer,
	})

	const result = Array.isArray(out) ? out[0] : out
	type OutChunk = { timestamp?: [number, number | null]; text?: string }
	const chunks = (result.chunks ?? []).map((c: OutChunk) => ({
		start: c.timestamp?.[0] ?? 0,
		// A final chunk can carry a null end timestamp; fall back to the start
		// rather than emitting a segment that claims to end at zero.
		stop: c.timestamp?.[1] ?? c.timestamp?.[0] ?? 0,
		text: c.text ?? '',
	}))

	post({
		type: 'done',
		id: req.id,
		text: (result.text ?? '').trim(),
		chunks,
		elapsedSec: (performance.now() - startedAt) / 1000,
	})
}

ctx.onmessage = async (event: MessageEvent<WorkerRequest>) => {
	const req = event.data
	try {
		if (req.type === 'preload') {
			await getPipeline(req.id, req.repo, req.backend, req.dtype)
			post({ type: 'ready', id: req.id })
			return
		}
		await transcribe(req)
	} catch (err) {
		post({ type: 'error', id: req.id, message: err instanceof Error ? err.message : String(err) })
	}
}
