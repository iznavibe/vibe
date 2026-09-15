/**
 * The models the phone can run by itself.
 *
 * The desktop picks its model from whatever is on disk and reports it through
 * `capabilities`. On-device there is no such freedom: the model has to be
 * downloaded over the network once, kept in browser storage, and held in a
 * phone's memory budget. So this is a short, curated list rather than a
 * directory listing, and every entry is an ONNX export that transformers.js
 * can load as-is.
 *
 * Sizes are the on-disk footprint of the quantised weights, which is what the
 * user is being asked to download and keep; they are approximate and only ever
 * shown to a human deciding whether to spend the bytes.
 */

import type { DataType } from '@huggingface/transformers'

export interface ModelVariant {
	/**
	 * Per-file quantisation, naming real files in the repo — transformers.js
	 * maps each dtype to a filename suffix (`fp16` -> `_fp16.onnx`,
	 * `q8` -> `_quantized.onnx`, `q4` -> `_q4.onnx`).
	 */
	dtype: Record<string, DataType>
	/** Measured sum of the files `dtype` resolves to. Not an estimate. */
	approxBytes: number
}

export interface LocalModel {
	id: string
	/** Hugging Face repo, loaded by transformers.js. */
	repo: string
	label: string
	/**
	 * Quantisation is not a free choice — it has to suit the backend.
	 *
	 * On the CPU backend an fp16 encoder fails outright ("Missing required
	 * scale ... MatMulNBits"), and so does a q8 merged decoder; q8 encoder with
	 * a q4 decoder loads and runs. On WebGPU the fp16/q4f16 pair is both
	 * smaller and faster. These were established by running each combination,
	 * not inferred.
	 *
	 * A `null` wasm variant means the model is not usable on the CPU backend —
	 * it exists, it would download, and it would not finish.
	 */
	variants: { webgpu: ModelVariant; wasm: ModelVariant | null }
	note: string
}

const MB = 1024 * 1024

/**
 * Ordered cheapest first — the list a user scrolls when deciding.
 *
 * `large-v3-turbo` is the same checkpoint the desktop build defaults to and
 * the only entry that comes close to what a paired desktop would send back.
 * The smaller two exist because a phone under memory pressure is better served
 * by a worse transcript than by a tab the OS kills halfway through.
 *
 * Sizes are measured sums of the files each dtype resolves to, because
 * guessing them went badly: turbo's encoder was configured at fp16, a 1215 MB
 * file, against an advertised 600 MB total, and phones died loading it.
 */
export const LOCAL_MODELS: LocalModel[] = [
	{
		id: 'base',
		repo: 'onnx-community/whisper-base',
		label: 'Base',
		variants: {
			// encoder_model_fp16 39.4 + decoder_model_merged_quantized 51.2
			webgpu: { dtype: { encoder_model: 'fp16', decoder_model_merged: 'q8' }, approxBytes: 91 * MB },
			// encoder_model_quantized 22.1 + decoder_model_merged_q4 117.9
			wasm: { dtype: { encoder_model: 'q8', decoder_model_merged: 'q4' }, approxBytes: 140 * MB },
		},
		note: 'Fastest and smallest, and the only one that keeps up in Safari. Fine for clear speech; weaker on other languages.',
	},
	{
		id: 'small',
		repo: 'onnx-community/whisper-small',
		label: 'Small',
		variants: {
			// encoder_model_fp16 168.4 + decoder_model_merged_quantized 149.5
			webgpu: { dtype: { encoder_model: 'fp16', decoder_model_merged: 'q8' }, approxBytes: 318 * MB },
			// encoder_model_quantized 88.0 + decoder_model_merged_q4 222.3
			wasm: { dtype: { encoder_model: 'q8', decoder_model_merged: 'q4' }, approxBytes: 310 * MB },
		},
		note: 'Noticeably better than Base outside English, but far slower without GPU acceleration — minutes per minute of audio in Safari.',
	},
	{
		id: 'large-v3-turbo',
		repo: 'onnx-community/whisper-large-v3-turbo',
		label: 'Large v3 Turbo',
		variants: {
			// encoder_model_q4f16 352.8 + decoder_model_merged_q4f16 184.5
			webgpu: { dtype: { encoder_model: 'q4f16', decoder_model_merged: 'q4f16' }, approxBytes: 537 * MB },
			/*
				Nothing honest to offer on CPU. The fp16 weights this model is
				worth using do not load on that backend at all, and the ones that
				do come to ~724 MB of int4 that a phone would spend the download
				on and then fail to run at any usable speed. Offering it would
				cost the user most of a gigabyte to discover that.
			*/
			wasm: null,
		},
		note: 'Closest to what your desktop produces. Needs GPU acceleration — not available in Safari.',
	},
]

export function variantFor(model: LocalModel, backend: 'webgpu' | 'wasm'): ModelVariant | null {
	return model.variants[backend]
}

/** The models this backend can actually run, in list order. */
export function modelsFor(backend: 'webgpu' | 'wasm'): LocalModel[] {
	return LOCAL_MODELS.filter((m) => m.variants[backend] !== null)
}

export const DEFAULT_MODEL_ID = 'base'

export function findModel(id: string): LocalModel | undefined {
	return LOCAL_MODELS.find((m) => m.id === id)
}

/**
 * The next model down from one that proved too heavy, or null when it is
 * already the smallest — in which case the device cannot run any of them and
 * offering an alternative would be a lie. Relies on LOCAL_MODELS being ordered
 * smallest first, which a test enforces.
 */
export function smallerThan(model: LocalModel, backend: 'webgpu' | 'wasm' = 'webgpu'): LocalModel | null {
	const runnable = modelsFor(backend)
	const index = runnable.findIndex((m) => m.id === model.id)
	// Not in the runnable list at all (the backend changed under a saved
	// choice): the largest one this backend can run is the right suggestion.
	if (index === -1) return runnable.at(-1) ?? null
	return index > 0 ? runnable[index - 1] : null
}

export const MODEL_KEY = 'vibe.local.model'
export const ENGINE_KEY = 'vibe.local.engine'

/** Which engine the user last chose. `auto` prefers the desktop when it answers. */
export type EngineChoice = 'auto' | 'desktop' | 'device'

export function loadEngineChoice(): EngineChoice {
	try {
		const raw = localStorage.getItem(ENGINE_KEY)
		if (raw === 'auto' || raw === 'desktop' || raw === 'device') return raw
	} catch {
		// Storage can be unavailable in a locked-down browser; the default is fine.
	}
	return 'auto'
}

export function saveEngineChoice(choice: EngineChoice): void {
	try {
		localStorage.setItem(ENGINE_KEY, choice)
	} catch {
		// Not worth surfacing: it only costs the user the preference next launch.
	}
}

export function loadModelId(): string {
	try {
		const raw = localStorage.getItem(MODEL_KEY)
		if (raw && findModel(raw)) return raw
	} catch {
		// As above.
	}
	return DEFAULT_MODEL_ID
}

export function saveModelId(id: string): void {
	try {
		localStorage.setItem(MODEL_KEY, id)
	} catch {
		// As above.
	}
}

/**
 * Whether a model's files are already in the browser cache, so the UI can say
 * "ready" instead of "600 MB" without starting a download to find out.
 *
 * transformers.js writes through the Cache API under this name. Reading it
 * directly couples us to that implementation detail, which is why the check is
 * advisory: a miss means "we could not confirm", never "it will re-download".
 */
export async function isModelCached(model: LocalModel): Promise<boolean> {
	try {
		if (!('caches' in window)) return false
		const cache = await caches.open('transformers-cache')
		const keys = await cache.keys()
		const prefix = model.repo.toLowerCase()
		return keys.some((req) => req.url.toLowerCase().includes(prefix))
	} catch {
		return false
	}
}

/** Drop a model's cached files. The only way a user can reclaim the space. */
export async function evictModel(model: LocalModel): Promise<void> {
	if (!('caches' in window)) return
	const cache = await caches.open('transformers-cache')
	const keys = await cache.keys()
	const prefix = model.repo.toLowerCase()
	await Promise.all(keys.filter((req) => req.url.toLowerCase().includes(prefix)).map((req) => cache.delete(req)))
}
