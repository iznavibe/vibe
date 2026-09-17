/**
 * The on-device engine, dressed as a handoff.
 *
 * `useHandoffSession` already knows how to drive a transcription: it reads a
 * `ReadableStream` of `HandoffEvent` and turns upload progress, model loading,
 * segments and a terminal `done` into UI. That loop is not specific to iroh —
 * it is specific to the event shape. So rather than teach the session a second
 * set of states, the local engine produces the *same* stream, and the session
 * cannot tell which one it is reading.
 *
 * The events it never emits are `uploadProgress` and `accepted`: nothing is
 * uploaded, and there is no desktop to accept it. The session treats their
 * absence as "not started yet", which is exactly right.
 */

import type { HandoffEvent } from '../handoff'
import { decodeToPcm, durationOf } from './audio'
import { variantFor, type LocalModel, type Runtime } from './models'
import { markLoadFinished, markLoadStarted } from './crash'
import { pickBackend } from './backend'
import { resetWhisper, runWhisper } from './whisper-client'
import type { WorkerReply, WorkerRequest } from './worker'

export interface LocalRunOptions {
	blob: Blob
	/** ISO code, or null for auto-detect. Travels with the recording. */
	lang: string | null
	model: LocalModel
	signal?: AbortSignal
}

/**
 * One worker for the page, created on first use.
 *
 * Workers are not free — spawning one per recording would re-download nothing
 * but would re-initialise the WebGPU session every time, which is the
 * expensive part. Keeping one alive lets `worker.ts` hold its loaded pipeline
 * across a queue of recordings.
 */
let worker: Worker | null = null
let workerRuntime: Runtime | null = null

/**
 * One worker for the page, for the ONNX engine.
 *
 * Workers are not free — spawning one per recording would re-initialise the
 * engine every time, which is the expensive part.
 *
 * Only the ONNX path has one. whisper.cpp runs from the main thread and owns
 * its own worker internally; see `whisper-client.ts` for why it cannot be
 * nested inside one of ours.
 */
function getWorker(runtime: Runtime): Worker {
	if (worker && workerRuntime !== runtime) {
		worker.terminate()
		worker = null
	}
	if (!worker) {
		worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
		workerRuntime = runtime
	}
	return worker
}

/**
 * Tear the worker down. A failed run can leave a wedged GPU session behind,
 * and the only reliable reset for that is a fresh worker.
 */
export function resetEngine(): void {
	worker?.terminate()
	worker = null
	workerRuntime = null
}

let counter = 0

function nextId(): string {
	counter += 1
	return `local-${counter}`
}

/**
 * Whether this browser can run the on-device engine at all.
 *
 * This used to require WebGPU, which was wrong twice over: it shut the feature
 * off entirely on every iPhone below iOS 26, and it promised the fast path on
 * WebKit where that path is precisely what crashes. The WASM backend needs
 * nothing but a worker, so the honest answer is now almost always yes — slow
 * on some devices, absent on none.
 */
export async function localEngineAvailable(): Promise<boolean> {
	return typeof Worker !== 'undefined' && typeof WebAssembly !== 'undefined'
}

/**
 * Transcribe locally, emitting the handoff event stream.
 *
 * Decoding happens on the main thread before the worker is involved, because
 * `decodeAudioData` lives on Web Audio and a worker has no access to it. It is
 * fast relative to inference and the wait is reported as a `status` phase so
 * the UI is never silent.
 */
/**
 * The whisper.cpp path, as the same `HandoffEvent` stream.
 *
 * Runs on the main thread rather than in a worker — see `whisper-client.ts` for
 * why — so the events are produced directly instead of being relayed from
 * `postMessage`. The shape is identical, which is the whole point: the session
 * cannot tell the two engines apart.
 */
function whisperStream(opts: LocalRunOptions): ReadableStream<HandoffEvent> {
	return new ReadableStream<HandoffEvent>({
		async start(controller) {
			let closed = false
			const finish = (event: HandoffEvent) => {
				if (closed) return
				closed = true
				markLoadFinished()
				controller.enqueue(event)
				controller.close()
			}

			try {
				if (!opts.model.ggmlUrl) throw new Error(`${opts.model.label} has no weights configured.`)

				controller.enqueue({ type: 'status', phase: 'decoding' })
				const pcm = await decodeToPcm(opts.blob)

				// Everything past here can exhaust memory and take the page with
				// it; this breadcrumb is the only evidence left if it does.
				markLoadStarted(opts.model.id)

				let announced: 'downloading' | 'loading' | null = null
				const run = await runWhisper(
					{ modelUrl: opts.model.ggmlUrl, pcm, lang: opts.lang },
					{
						onDownload(pct, cached) {
							// A first download of half a gigabyte and a read from cache
							// are very different waits; saying "downloading" for the
							// second is how a user concludes the cache is not working.
							const phase = cached ? 'loading_model' : 'downloading_model'
							if (announced !== (cached ? 'loading' : 'downloading')) {
								announced = cached ? 'loading' : 'downloading'
								controller.enqueue({ type: 'status', phase })
							}
							controller.enqueue({ type: 'progress', progress: pct })
						},
						onReady() {
							markLoadFinished()
							controller.enqueue({ type: 'status', phase: 'transcribing' })
						},
						onProgress(pct) {
							controller.enqueue({ type: 'progress', progress: pct })
						},
					},
				)

				for (const chunk of run.chunks) {
					controller.enqueue({ type: 'segment', start: chunk.start, stop: chunk.stop, text: chunk.text, speaker: null })
				}
				finish({ type: 'done', text: run.text, processingTimeSec: run.elapsedSec })
			} catch (err) {
				resetWhisper()
				finish({ type: 'error', code: 'local_engine', message: err instanceof Error ? err.message : String(err) })
			}
		},
	})
}

export function transcribeLocally(opts: LocalRunOptions): ReadableStream<HandoffEvent> {
	const id = nextId()

	if (opts.model.runtime === 'whisper-cpp') return whisperStream(opts)

	return new ReadableStream<HandoffEvent>({
		async start(controller) {
			const w = getWorker(opts.model.runtime)
			let settled = false

			const finish = (event: HandoffEvent) => {
				if (settled) return
				settled = true
				controller.enqueue(event)
				w.removeEventListener('message', onMessage)
				w.removeEventListener('error', onError)
				controller.close()
			}

			const onMessage = (e: MessageEvent<WorkerReply>) => {
				const reply = e.data
				if (reply.id !== id) return

				switch (reply.type) {
					case 'download':
						// Two different waits with very different meanings: a first
						// download of several hundred megabytes, or a read out of the
						// cache. Saying "downloading" for the second is how a user
						// concludes the cache is not working.
						controller.enqueue({ type: 'status', phase: reply.cached ? 'loading_model' : 'downloading_model' })
						controller.enqueue({ type: 'progress', progress: reply.pct })
						break
					case 'ready':
						// Survived the load, so there is no crash to report.
						markLoadFinished()
						controller.enqueue({ type: 'status', phase: 'transcribing' })
						break
					case 'progress':
						controller.enqueue({ type: 'progress', progress: reply.pct })
						break
					case 'partial':
						// Live text arrives as a growing string, but the session appends
						// segments. Emitting each partial as a segment would repeat the
						// whole transcript, so partials are dropped and the real segments
						// are emitted once, from `done`.
						break
					case 'done': {
						for (const chunk of reply.chunks) {
							controller.enqueue({ type: 'segment', start: chunk.start, stop: chunk.stop, text: chunk.text, speaker: null })
						}
						finish({ type: 'done', text: reply.text, processingTimeSec: reply.elapsedSec })
						break
					}
					case 'error':
						// A reported error is not a crash — the page is still alive to
						// show it, so the breadcrumb would be a false positive.
						markLoadFinished()
						finish({ type: 'error', code: 'local_engine', message: reply.message })
						break
				}
			}

			const onError = (e: ErrorEvent) => {
				markLoadFinished()
				resetEngine()
				finish({ type: 'error', code: 'local_engine', message: e.message || 'The on-device engine stopped unexpectedly.' })
			}

			w.addEventListener('message', onMessage)
			w.addEventListener('error', onError)

			opts.signal?.addEventListener('abort', () => {
				// There is no way to interrupt a generation mid-flight, so cancelling
				// means discarding the worker outright.
				resetEngine()
				finish({ type: 'error', code: 'cancelled', message: 'Transcription was cancelled.' })
			})

			try {
				controller.enqueue({ type: 'status', phase: 'decoding' })
				const pcm = await decodeToPcm(opts.blob)

				// From here the worker loads weights, which is the step that can
				// exhaust memory and take the whole page with it. If that happens
				// nothing below runs, and this breadcrumb is the only evidence left.
				markLoadStarted(opts.model.id)

				const backend = await pickBackend()
				const variant = variantFor(opts.model, backend)
				if (!variant) {
					throw new Error(
						`${opts.model.label} cannot run on this browser's backend. Choose a smaller model in settings, or send this to your desktop.`,
					)
				}
				const request: WorkerRequest = {
					type: 'transcribe',
					id,
					repo: opts.model.repo,
					backend,
					dtype: variant.dtype,
					lang: opts.lang,
					pcm,
					durationSec: durationOf(pcm),
				}
				// The PCM is transferred, not copied: an hour of 16 kHz float is
				// ~230 MB and structured-cloning that on a phone is a real stall.
				w.postMessage(request, [pcm.buffer])
			} catch (err) {
				markLoadFinished()
				finish({ type: 'error', code: 'decode_failed', message: err instanceof Error ? err.message : String(err) })
			}
		},
	})
}
