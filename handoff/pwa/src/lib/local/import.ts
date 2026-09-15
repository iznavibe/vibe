/**
 * Picking an existing recording instead of making a new one.
 *
 * Recording covers the case the app was built for — something happening now.
 * Most audio worth transcribing already exists: a voice memo, a lecture someone
 * sent, a video off the camera roll. The picker reaches both the photo library
 * and Files on iOS, so this is the same feature for all of them.
 *
 * The audio path is unchanged: whatever comes back goes through `decodeToPcm`
 * like a recording does, because `decodeAudioData` pulls the audio track out of
 * a video container as readily as out of an audio one.
 */

/**
 * What the picker offers.
 *
 * Deliberately broad rather than an extension list: iOS matches these against
 * UTIs, and a narrow list is how you end up with a file greyed out in the
 * picker for no reason the user can see.
 */
export const IMPORT_ACCEPT = 'audio/*,video/*'

/**
 * The longest clip that will be accepted, and the reason there is a limit at
 * all.
 *
 * `decodeAudioData` decodes the *whole* file before anything can be done with
 * it, at the file's own rate and channel count — 48 kHz stereo float32 is
 * ~384 KB per second, so an hour of video becomes ~1.4 GB resident before the
 * downmix to 16 kHz mono shrinks it to ~230 MB. A phone tab does not survive
 * that, and it dies partway through a long wait, which is the worst possible
 * moment to discover a limit.
 *
 * 30 minutes puts the decode peak near 700 MB, which a recent iPhone tolerates.
 * The real fix is streaming the audio track through WebCodecs rather than
 * decoding the file whole; until then this is a cap the user is told about
 * before they wait, rather than a crash they find out about after.
 */
export const MAX_IMPORT_SECONDS = 30 * 60

/** Bytes per second of decoded audio, assuming 48 kHz stereo float32. */
const DECODED_BYTES_PER_SEC = 48_000 * 2 * 4

/**
 * Below this, the duration probe is skipped entirely.
 *
 * Speech codecs bottom out around 16 kbps, or 2 KB per second — nothing a phone
 * produces or a person sends is meaningfully denser than that. So a file under
 * `MAX_IMPORT_SECONDS × 2 KB` cannot be over the limit however it was encoded,
 * and probing it only buys a wait. That covers essentially every voice memo,
 * which is the common case and the one that should feel instant.
 */
const PROBE_FLOOR_BYTES = MAX_IMPORT_SECONDS * 2_000

/**
 * How long to wait for a container's metadata.
 *
 * Reading a local file's header is near-instant when it works at all, so this
 * is a stall-breaker rather than a real deadline: some containers never fire
 * either event, and an import that hangs is worse than one that proceeds and
 * lets the decode fail with a real message.
 */
const PROBE_TIMEOUT_MS = 5_000

/**
 * Read a clip's duration without decoding it.
 *
 * A media element only needs the container's metadata to answer this, so it
 * costs a header read rather than the gigabyte the full decode would.
 * Resolves `null` when the browser cannot tell — a stream with no duration in
 * its header — which the caller must treat as "unknown", never as "zero".
 */
export function probeDuration(file: File): Promise<number | null> {
	return new Promise((resolve) => {
		const url = URL.createObjectURL(file)
		const el = document.createElement(file.type.startsWith('video/') ? 'video' : 'audio')

		const done = (value: number | null) => {
			el.removeAttribute('src')
			el.load()
			URL.revokeObjectURL(url)
			resolve(value)
		}

		el.preload = 'metadata'
		el.onloadedmetadata = () => done(Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null)
		el.onerror = () => done(null)
		// A container the browser cannot parse never fires either handler, and a
		// picker that hangs silently is worse than one that admits defeat.
		setTimeout(() => done(null), PROBE_TIMEOUT_MS)
		el.src = url
	})
}

export interface ImportRejection {
	code: 'too_long' | 'empty'
	message: string
}

function formatMinutes(seconds: number): string {
	const mins = Math.round(seconds / 60)
	return mins === 1 ? '1 minute' : `${mins} minutes`
}

/** True when a file is big enough that its duration is worth measuring. */
export function needsProbe(sizeBytes: number): boolean {
	return sizeBytes >= PROBE_FLOOR_BYTES
}

/**
 * The decision itself, given what we know. Pure, so it can be tested without a
 * DOM: `rejectImport` is only this plus the probe that feeds it.
 *
 * A `null` duration is allowed through on purpose — refusing everything the
 * browser cannot pre-measure would reject valid files, and the decode fails
 * safely with its own message if it really is too big.
 */
export function evaluateImport(sizeBytes: number, durationSec: number | null): ImportRejection | null {
	if (sizeBytes === 0) {
		return { code: 'empty', message: 'That file is empty.' }
	}

	if (durationSec !== null && durationSec > MAX_IMPORT_SECONDS) {
		const peakGb = (durationSec * DECODED_BYTES_PER_SEC) / (1024 * 1024 * 1024)
		return {
			code: 'too_long',
			message:
				`That clip is ${formatMinutes(durationSec)} long. This phone decodes the whole file at once, which would need around ` +
				`${peakGb.toFixed(1)} GB of memory and would stop the app partway through. Trim it to ` +
				`${formatMinutes(MAX_IMPORT_SECONDS)} or less, or send it to your desktop instead.`,
		}
	}

	return null
}

/**
 * Decide whether a picked file can be transcribed here, before any of the
 * expensive work starts. Returns `null` when it is fine.
 */
export async function rejectImport(file: File): Promise<ImportRejection | null> {
	if (file.size === 0) return evaluateImport(0, null)
	if (!needsProbe(file.size)) return null
	return evaluateImport(file.size, await probeDuration(file))
}
