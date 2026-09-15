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

export interface LocalModel {
	id: string
	/** Hugging Face repo, loaded by transformers.js. */
	repo: string
	label: string
	/** Roughly what the download costs, for the UI. */
	approxBytes: number
	/**
	 * Per-file quantisation. The encoder stays at fp16 on WebGPU because it is
	 * the compute-bound half and quantising it buys little; the decoder is the
	 * one that dominates the download, so it takes the q4 hit.
	 */
	dtype: Record<string, DataType>
	note: string
}

const MB = 1024 * 1024

/**
 * Ordered cheapest first — the list a user scrolls when deciding.
 *
 * `large-v3-turbo` is the same checkpoint the desktop build defaults to, which
 * is the point: it is the only entry here that produces transcripts close to
 * what the paired desktop would send back. The smaller two exist because a
 * phone under memory pressure is better served by a worse transcript than by a
 * tab the OS kills halfway through.
 */
export const LOCAL_MODELS: LocalModel[] = [
	{
		id: 'base',
		repo: 'onnx-community/whisper-base',
		label: 'Base',
		approxBytes: 145 * MB,
		dtype: { encoder_model: 'fp16', decoder_model_merged: 'q8' },
		note: 'Fastest and smallest. Fine for clear English; weak on other languages.',
	},
	{
		id: 'small',
		repo: 'onnx-community/whisper-small',
		label: 'Small',
		approxBytes: 300 * MB,
		dtype: { encoder_model: 'fp16', decoder_model_merged: 'q8' },
		note: 'A reasonable middle. Noticeably better than Base outside English.',
	},
	{
		id: 'large-v3-turbo',
		repo: 'onnx-community/whisper-large-v3-turbo',
		label: 'Large v3 Turbo',
		approxBytes: 600 * MB,
		dtype: { encoder_model: 'fp16', decoder_model_merged: 'q4f16' },
		note: 'Closest to what your desktop produces. Needs a recent phone and a long first download.',
	},
]

export const DEFAULT_MODEL_ID = 'large-v3-turbo'

export function findModel(id: string): LocalModel | undefined {
	return LOCAL_MODELS.find((m) => m.id === id)
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
