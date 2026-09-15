import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createProgressTracker } from '../src/lib/local/progress.ts'

/**
 * The offsets below are not invented: they are what
 * `WhisperTextStreamer.on_chunk_start` actually emitted for the 47.6 s
 * `server/fixtures/multi.wav`, captured while building this. The reset from
 * 29 back to 1 partway through is the whole reason this module exists.
 */
const REAL_OFFSETS = [0, 2, 3, 5, 6, 7, 10, 13, 17, 18, 23, 25, 26, 29, 1, 3.6, 4.72, 5.72, 9.28, 10.04, 11.2, 12.72, 13.32, 15, 16.24, 17.2, 23.56, 27.44]
const REAL_DURATION = 47.6

test('a single window maps offsets straight onto the duration', () => {
	const p = createProgressTracker(20)
	assert.equal(p.push(0), 0)
	assert.equal(p.push(5), 25)
	assert.equal(p.push(10), 50)
	assert.equal(p.push(15), 75)
})

test('a window reset does not send progress backwards', () => {
	const p = createProgressTracker(REAL_DURATION)
	const seen = REAL_OFFSETS.map((o) => p.push(o))

	for (let i = 1; i < seen.length; i += 1) {
		assert.ok(seen[i] >= seen[i - 1], `progress went backwards at ${i}: ${seen[i - 1]} -> ${seen[i]}`)
	}
})

test('progress spans most of the bar over a real recording', () => {
	const p = createProgressTracker(REAL_DURATION)
	const seen = REAL_OFFSETS.map((o) => p.push(o))

	assert.equal(seen[0], 0)
	// The point of carrying a base: without it the last value would be 27/47.6
	// = 58%, and the bar would have visibly rewound to get there.
	assert.ok(seen.at(-1) >= 90, `expected to finish near the end, got ${seen.at(-1)}`)
})

test('never reports complete — only a terminal `done` may do that', () => {
	const p = createProgressTracker(10)
	assert.equal(p.push(10), 99)
	assert.equal(p.push(1000), 99)
})

test('a zero or unknown duration is reported as no progress, not NaN', () => {
	const p = createProgressTracker(0)
	assert.equal(p.push(5), 0)
	assert.equal(p.push(30), 0)
})

test('an offset of exactly the last value is not treated as a reset', () => {
	const p = createProgressTracker(100)
	assert.equal(p.push(50), 50)
	// Repeats happen; they must not fold a whole window into the base.
	assert.equal(p.push(50), 50)
	assert.equal(p.push(60), 60)
})
