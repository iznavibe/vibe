/**
 * Decoding captured audio to the PCM Whisper wants.
 *
 * On the desktop this job belongs to ffmpeg, which Vibe ships as a sidecar. A
 * phone has no sidecar to spawn, so the browser does it: `decodeAudioData`
 * understands everything `MediaRecorder` produces on iOS (AAC in MP4) and
 * Android (Opus in WebM), plus whatever the user imports.
 *
 * Whisper is fixed at 16 kHz mono float. Anything else is silently wrong —
 * feeding it 48 kHz produces confident nonsense at three times the speed — so
 * the resample is not optional.
 */

/** What Whisper's feature extractor expects. Not a tunable. */
export const TARGET_SAMPLE_RATE = 16_000

type AudioContextCtor = typeof AudioContext

function audioContextCtor(): AudioContextCtor {
	const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor }
	const ctor = w.AudioContext ?? w.webkitAudioContext
	if (!ctor) throw new Error('This browser has no Web Audio support, so audio cannot be decoded on the device.')
	return ctor
}

/**
 * Resample by rendering through an OfflineAudioContext, which also downmixes to
 * mono for free because the destination is declared with one channel.
 *
 * Safari spent years rejecting any sample rate but the hardware's here, and
 * `startRendering` is the call that fails when it does. The linear fallback
 * below is the insurance: worse resampling than the browser's, but Whisper is
 * unbothered by it, and a slightly soft resample beats a hard failure.
 */
async function resampleViaOfflineContext(decoded: AudioBuffer): Promise<Float32Array> {
	const frames = Math.ceil(decoded.duration * TARGET_SAMPLE_RATE)
	const offline = new OfflineAudioContext(1, frames, TARGET_SAMPLE_RATE)
	const source = offline.createBufferSource()
	source.buffer = decoded
	source.connect(offline.destination)
	source.start()
	const rendered = await offline.startRendering()
	return rendered.getChannelData(0)
}

/** Average the channels, then walk the source at a fractional step. */
function resampleLinear(decoded: AudioBuffer): Float32Array {
	const channels: Float32Array[] = []
	for (let c = 0; c < decoded.numberOfChannels; c += 1) channels.push(decoded.getChannelData(c))

	const ratio = decoded.sampleRate / TARGET_SAMPLE_RATE
	const outLength = Math.floor(decoded.length / ratio)
	const out = new Float32Array(outLength)

	for (let i = 0; i < outLength; i += 1) {
		const pos = i * ratio
		const left = Math.floor(pos)
		const right = Math.min(left + 1, decoded.length - 1)
		const t = pos - left

		let sum = 0
		for (const channel of channels) sum += channel[left] * (1 - t) + channel[right] * t
		out[i] = sum / channels.length
	}
	return out
}

/**
 * Decode any container the browser understands into 16 kHz mono float samples.
 *
 * The decode itself needs a live AudioContext (an OfflineAudioContext cannot
 * decode at an arbitrary source rate), which is closed as soon as it has done
 * its job — iOS caps how many a page may hold open, and leaking them here
 * would break recording later in the session.
 */
export async function decodeToPcm(blob: Blob): Promise<Float32Array> {
	const bytes = await blob.arrayBuffer()
	if (bytes.byteLength === 0) throw new Error('The recording is empty.')

	const ctx = new (audioContextCtor())()
	let decoded: AudioBuffer
	try {
		decoded = await ctx.decodeAudioData(bytes)
	} catch (err) {
		throw new Error(`This audio could not be decoded on the device (${err instanceof Error ? err.message : String(err)}).`)
	} finally {
		void ctx.close()
	}

	if (decoded.sampleRate === TARGET_SAMPLE_RATE && decoded.numberOfChannels === 1) {
		return decoded.getChannelData(0)
	}

	try {
		return await resampleViaOfflineContext(decoded)
	} catch {
		return resampleLinear(decoded)
	}
}

/** Seconds of audio, from the sample count. Used to size progress and report speed. */
export function durationOf(pcm: Float32Array): number {
	return pcm.length / TARGET_SAMPLE_RATE
}
