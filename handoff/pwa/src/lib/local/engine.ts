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
import type { LocalModel } from './models'
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

function getWorker(): Worker {
	if (!worker) {
		worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
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
}

let counter = 0

function nextId(): string {
	counter += 1
	return `local-${counter}`
}

/** Whether this browser can run the on-device engine at all. */
export async function localEngineAvailable(): Promise<boolean> {
	if (typeof Worker === 'undefined') return false
	const gpu = (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
	if (!gpu) return false
	try {
		// Presence of `navigator.gpu` is not the same as a usable adapter: a
		// browser can expose the API and still fail to hand one over.
		return (await gpu.requestAdapter()) !== null
	} catch {
		return false
	}
}

/**
 * Transcribe locally, emitting the handoff event stream.
 *
 * Decoding happens on the main thread before the worker is involved, because
 * `decodeAudioData` lives on Web Audio and a worker has no access to it. It is
 * fast relative to inference and the wait is reported as a `status` phase so
 * the UI is never silent.
 */
export function transcribeLocally(opts: LocalRunOptions): ReadableStream<HandoffEvent> {
	const id = nextId()

	return new ReadableStream<HandoffEvent>({
		async start(controller) {
			const w = getWorker()
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
						// Reuses the desktop's vocabulary: the session already shows an
						// indeterminate bar and "Loading model…" for this phase, and a
						// download is what loading a model means here.
						controller.enqueue({ type: 'status', phase: 'loading_model' })
						controller.enqueue({ type: 'progress', progress: reply.pct })
						break
					case 'ready':
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
						finish({ type: 'error', code: 'local_engine', message: reply.message })
						break
				}
			}

			const onError = (e: ErrorEvent) => {
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

				const request: WorkerRequest = {
					type: 'transcribe',
					id,
					repo: opts.model.repo,
					dtype: opts.model.dtype,
					lang: opts.lang,
					pcm,
					durationSec: durationOf(pcm),
				}
				// The PCM is transferred, not copied: an hour of 16 kHz float is
				// ~230 MB and structured-cloning that on a phone is a real stall.
				w.postMessage(request, [pcm.buffer])
			} catch (err) {
				finish({ type: 'error', code: 'decode_failed', message: err instanceof Error ? err.message : String(err) })
			}
		},
	})
}
