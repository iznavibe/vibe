/**
 * Turning Whisper's chunk offsets into a progress percentage.
 *
 * `WhisperTextStreamer.on_chunk_start` reports where a segment begins *within
 * the current 30 s window*, not within the recording. For anything longer than
 * one window the raw signal counts up, resets, and counts up again — a 48 s
 * recording reports 0…29, then 1…27. Fed straight to a progress bar that reads
 * as climbing past halfway and then jumping backwards, on exactly the long
 * recordings where a progress bar is worth having.
 *
 * This carries a base across those resets. It is approximate at the seams —
 * windows overlap by `stride_length_s`, which this deliberately does not model,
 * so the base over-counts slightly — and it is clamped monotonic, because a bar
 * that never goes backwards is worth more to the user than one that is precise.
 */
export interface ProgressTracker {
	/** Absolute percentage for a raw window-relative offset, never decreasing. */
	push(offsetSec: number): number
}

/** A drop larger than this means the window rolled over, not a rounding wobble. */
const RESET_EPSILON = 0.5

/** Held below 100 until the run actually reports `done`. */
const CEILING = 99

export function createProgressTracker(durationSec: number): ProgressTracker {
	let windowBase = 0
	let lastOffset = 0
	let lastPct = 0

	return {
		push(offsetSec: number): number {
			if (!(durationSec > 0)) return lastPct

			if (offsetSec < lastOffset - RESET_EPSILON) windowBase += lastOffset
			lastOffset = offsetSec

			const pct = Math.round(((windowBase + offsetSec) / durationSec) * 100)
			lastPct = Math.max(lastPct, Math.max(0, Math.min(CEILING, pct)))
			return lastPct
		},
	}
}
