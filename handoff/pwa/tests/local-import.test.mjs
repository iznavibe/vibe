import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_IMPORT_SECONDS, evaluateImport, needsProbe } from '../src/lib/local/import.ts'

const MB = 1024 * 1024

test('an empty file is refused', () => {
	const r = evaluateImport(0, null)
	assert.equal(r?.code, 'empty')
})

test('a clip within the limit is accepted', () => {
	assert.equal(evaluateImport(10 * MB, 60), null)
	assert.equal(evaluateImport(400 * MB, MAX_IMPORT_SECONDS), null)
})

test('a clip over the limit is refused, and says how long it was', () => {
	const r = evaluateImport(900 * MB, 61 * 60)
	assert.equal(r?.code, 'too_long')
	assert.match(r.message, /61 minutes/)
	// The number that makes the refusal make sense: 61 min x 384 KB/s ~ 1.3 GB.
	assert.match(r.message, /1\.3 GB/)
})

test('an unmeasurable duration is allowed through rather than blocked', () => {
	// The browser could not read the container's metadata. Guessing "too long"
	// here would reject valid files; the decode fails safely on its own.
	assert.equal(evaluateImport(900 * MB, null), null)
})

test('files too small to possibly exceed the limit skip the probe', () => {
	// 16 kbps is about the floor for speech, so under MAX x 2 KB/s nothing can
	// be over the limit however it was encoded.
	assert.equal(needsProbe(1 * MB), false)
	assert.equal(needsProbe(3 * MB), false)
	assert.equal(needsProbe(50 * MB), true)
})

test('the probe floor matches the duration limit it is derived from', () => {
	// If MAX_IMPORT_SECONDS changes, the floor must move with it or the skip
	// starts letting genuinely over-long files through unmeasured.
	assert.equal(needsProbe(MAX_IMPORT_SECONDS * 2000 - 1), false)
	assert.equal(needsProbe(MAX_IMPORT_SECONDS * 2000), true)
})
