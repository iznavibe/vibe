/**
 * Choosing which ONNX Runtime backend to run on, and refusing to use WebGPU on
 * WebKit.
 *
 * ORT's WebGPU execution provider is JSEP, which on WebKit 26 sends the web
 * content process into a compilation loop: CPU pinned, memory climbing past a
 * gigabyte, and on iOS the process is killed outright. It is not a leak that
 * shows up after heavy use — a single Whisper load is enough. Upstream has it
 * open with no fix and no workaround:
 *
 *   https://github.com/microsoft/onnxruntime/issues/26827
 *   https://github.com/huggingface/transformers.js/issues/1242
 *
 * The plain WASM backend does not go through JSEP and is reported to work. It
 * is CPU-only and much slower, which is a real cost — but a slow transcript
 * beats an app that vanishes mid-run, and on iOS there is no third option:
 * every browser there is WebKit underneath, so this is not something the user
 * can dodge by switching to Chrome.
 *
 * The check is for the engine, not the vendor string: Chrome and Firefox on
 * macOS are not WebKit and keep the fast path.
 */

export type Backend = 'webgpu' | 'wasm'

/**
 * True for Safari and for every browser on iOS, which are all WebKit whatever
 * they are branded as.
 *
 * Detected by capability rather than user agent where possible — WebKit is the
 * only engine that exposes a non-standard `GestureEvent` — with a UA check as
 * the fallback for anything that hides it.
 */
export function isWebKit(): boolean {
	if (typeof window === 'undefined') return false
	if ('GestureEvent' in window) return true

	const ua = navigator.userAgent
	const isAppleMobile = /iPad|iPhone|iPod/.test(ua)
	const isSafari = /Safari/.test(ua) && !/Chrome|Chromium|Android/.test(ua)
	return isAppleMobile || isSafari
}

export async function webGpuUsable(): Promise<boolean> {
	const gpu = (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
	if (!gpu) return false
	try {
		return (await gpu.requestAdapter()) !== null
	} catch {
		return false
	}
}

/**
 * The backend to run on. WASM is always available, so unlike the WebGPU-only
 * arrangement this replaced, there is no device on which the engine simply
 * cannot run — only ones where it is slow.
 */
export async function pickBackend(): Promise<Backend> {
	if (isWebKit()) return 'wasm'
	return (await webGpuUsable()) ? 'webgpu' : 'wasm'
}
