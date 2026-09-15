/**
 * What the phone can do on its own, in the shape the UI already understands.
 *
 * Every control in this app reads a `Capabilities` reply, because until now the
 * desktop was the only thing that could transcribe and it was the authority on
 * what was possible. On-device that authority moves here: the language set is
 * Whisper's own, fixed by the architecture rather than by whatever the user
 * happens to have loaded on a desktop, and detection is always available.
 *
 * Synthesising a `Capabilities` rather than special-casing the components keeps
 * one code path through the UI — the language picker in particular does not
 * need to know which engine it is configuring.
 */

import type { Capabilities } from '../handoff'
import type { LocalModel } from './models'

/**
 * The 99 languages Whisper is trained on, taken from the tokenizer's own table
 * in `@huggingface/transformers` rather than transcribed by hand. Every
 * multilingual Whisper checkpoint shares this set, so it does not vary with the
 * model chosen in `models.ts`.
 */
export const WHISPER_LANGUAGES: string[] = [
	'en',
	'zh',
	'de',
	'es',
	'ru',
	'ko',
	'fr',
	'ja',
	'pt',
	'tr',
	'pl',
	'ca',
	'nl',
	'ar',
	'sv',
	'it',
	'id',
	'hi',
	'fi',
	'vi',
	'he',
	'uk',
	'el',
	'ms',
	'cs',
	'ro',
	'da',
	'hu',
	'ta',
	'no',
	'th',
	'ur',
	'hr',
	'bg',
	'lt',
	'la',
	'mi',
	'ml',
	'cy',
	'sk',
	'te',
	'fa',
	'lv',
	'bn',
	'sr',
	'az',
	'sl',
	'kn',
	'et',
	'mk',
	'br',
	'eu',
	'is',
	'hy',
	'ne',
	'mn',
	'bs',
	'kk',
	'sq',
	'sw',
	'gl',
	'mr',
	'pa',
	'si',
	'km',
	'sn',
	'yo',
	'so',
	'af',
	'oc',
	'ka',
	'be',
	'tg',
	'sd',
	'gu',
	'am',
	'yi',
	'lo',
	'uz',
	'fo',
	'ht',
	'ps',
	'tk',
	'nn',
	'mt',
	'sa',
	'lb',
	'my',
	'bo',
	'tl',
	'mg',
	'as',
	'tt',
	'haw',
	'ln',
	'ha',
	'ba',
	'jw',
	'su',
]

/**
 * `maxAudioBytes` is deliberately 0, meaning "no known limit". The desktop caps
 * uploads because the audio has to cross a network; nothing is uploaded here,
 * so the real constraint is the phone's memory, which shows up as a failed run
 * rather than as a number we could honestly put in front of the user.
 */
export function localCapabilities(model: LocalModel): Capabilities {
	return {
		type: 'capabilities',
		modelLoaded: true,
		modelName: `${model.label} (on device)`,
		languages: WHISPER_LANGUAGES,
		languageDetection: true,
		translation: false,
		maxAudioBytes: 0,
	}
}
