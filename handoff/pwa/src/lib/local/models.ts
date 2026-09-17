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

/**
 * Which engine runs a model.
 *
 * `onnx` is transformers.js over ONNX Runtime — fast enough for the small
 * models and already proven on a real phone. `whisper-cpp` is ggml through
 * whisper.cpp, the same engine the desktop uses, and the only one that runs
 * large-v3-turbo at a speed anyone would wait for: on one desktop CPU, 30 s of
 * audio took 74.5 s under whisper.cpp and over twenty minutes under ORT before
 * the run was abandoned.
 *
 * Both are kept rather than standardising on one. whisper.cpp wins where it
 * matters, but ORT is what currently works on the user's phone, and keeping it
 * means a model that fails takes only itself down rather than the feature.
 */
export type Runtime = 'onnx' | 'whisper-cpp'

export interface LocalModel {
	id: string
	/** Hugging Face repo, loaded by transformers.js. Unused by whisper.cpp models. */
	repo: string
	label: string
	runtime: Runtime
	/** whisper.cpp only: the ggml weights to download. */
	ggmlUrl?: string
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
		runtime: 'onnx',
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
		runtime: 'onnx',
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
		runtime: 'whisper-cpp',
		ggmlUrl: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin',
		/*
			Same 547 MB ggml file on either backend. whisper.cpp does not use the
			WebGPU/WASM split the ONNX models do — quantisation is baked into the
			file rather than chosen per backend — but both entries exist so the
			model is offered everywhere rather than being filtered out.

			Under ORT this model was unusable: over twenty minutes for ten seconds
			of audio before the run was abandoned. Under whisper.cpp the same
			machine did thirty seconds of audio in 74.5 s.
		*/
		variants: {
			webgpu: { dtype: {}, approxBytes: 547 * MB },
			wasm: { dtype: {}, approxBytes: 547 * MB },
		},
		note: 'Closest to your desktop. Slow on a phone — expect several minutes per minute of audio, with the screen kept on.',
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
/**
 * Which cache holds a model's weights, and what identifies them in it.
 *
 * The two runtimes store their downloads differently: transformers.js writes
 * ONNX files into `transformers-cache` under URLs containing the repo name,
 * while the whisper.cpp path writes one ggml file into `whisper-ggml` keyed by
 * its exact URL. Checking the wrong one makes settings report a downloaded
 * model as missing, and makes "Remove download" silently do nothing.
 */
function cacheLocation(model: LocalModel): { cacheName: string; match: string } {
	return model.runtime === 'whisper-cpp'
		? { cacheName: 'whisper-ggml', match: (model.ggmlUrl ?? '').toLowerCase() }
		: { cacheName: 'transformers-cache', match: model.repo.toLowerCase() }
}

export async function isModelCached(model: LocalModel): Promise<boolean> {
	try {
		if (!('caches' in window)) return false
		const { cacheName, match } = cacheLocation(model)
		if (!match) return false
		const cache = await caches.open(cacheName)
		const keys = await cache.keys()
		return keys.some((req) => req.url.toLowerCase().includes(match))
	} catch {
		return false
	}
}

/** Drop a model's cached files. The only way a user can reclaim the space. */
export async function evictModel(model: LocalModel): Promise<void> {
	if (!('caches' in window)) return
	const { cacheName, match } = cacheLocation(model)
	if (!match) return
	const cache = await caches.open(cacheName)
	const keys = await cache.keys()
	await Promise.all(keys.filter((req) => req.url.toLowerCase().includes(match)).map((req) => cache.delete(req)))
}
