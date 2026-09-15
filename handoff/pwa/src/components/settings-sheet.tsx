import { useEffect, useState, type ReactNode } from 'react'
import { Check, Download, Link2Off, Trash2, X } from 'lucide-react'

import { Button } from '~/components/ui/button'
import { LanguagePicker } from '~/components/language-picker'
import { truncateId, type Capabilities } from '~/lib/handoff'
import { LOCAL_MODELS, evictModel, isModelCached, type EngineChoice, type LocalModel } from '~/lib/local/models'
import { localCapabilities } from '~/lib/local/capabilities'
import { formatSize } from '~/lib/recorder'
import { cn } from '~/lib/style'

const ENGINE_OPTIONS: { value: EngineChoice; label: string; hint: string }[] = [
	{ value: 'auto', label: 'Automatic', hint: 'Use the desktop when it answers, this phone when it does not.' },
	{ value: 'desktop', label: 'Desktop only', hint: 'Always wait for the desktop. Queued until it is reachable.' },
	{ value: 'device', label: 'This phone', hint: 'Always transcribe here. Works with no desktop and no signal.' },
]

/**
 * A model row, with whatever we can tell the user about what it will cost.
 *
 * The cache check is advisory (see `isModelCached`) — it can only ever say
 * "already downloaded", never "will definitely re-download" — so a miss shows
 * the download size rather than a promise about what happens next.
 */
function ModelRow({ model, selected, onSelect }: { model: LocalModel; selected: boolean; onSelect: () => void }) {
	const [cached, setCached] = useState<boolean | null>(null)

	const refresh = () => {
		void isModelCached(model).then(setCached)
	}
	useEffect(refresh, [model])

	return (
		<div className={cn('px-4 py-3', selected && 'bg-accent/40')}>
			<button type="button" className="flex w-full items-start justify-between gap-3 text-left" onClick={onSelect}>
				<span className="min-w-0">
					<span className="flex items-center gap-2 text-sm font-medium">
						{model.label}
						{selected && <Check className="size-4 shrink-0" />}
					</span>
					<span className="mt-0.5 block text-xs text-muted-foreground">{model.note}</span>
				</span>
				<span className="shrink-0 text-xs whitespace-nowrap text-muted-foreground">
					{cached ? (
						<span className="inline-flex items-center gap-1">
							<Check className="size-3" />
							Ready
						</span>
					) : (
						<span className="inline-flex items-center gap-1">
							<Download className="size-3" />
							{formatSize(model.approxBytes)}
						</span>
					)}
				</span>
			</button>
			{cached && (
				<button
					type="button"
					className="mt-2 inline-flex items-center gap-1 text-xs text-muted-foreground underline underline-offset-2"
					onClick={() => void evictModel(model).then(refresh)}>
					<Trash2 className="size-3" />
					Remove download
				</button>
			)}
		</div>
	)
}

/**
 * The desktop app's settings grouping, ported verbatim from
 * `desktop/src/pages/settings/sections/shared.tsx` so the two read the same:
 * a 13px heading over one bordered container of hairline-divided rows.
 */
function SettingsGroup({ title, children }: { title?: ReactNode; children: ReactNode }) {
	return (
		<section className="space-y-2">
			{title && <h3 className="px-1 text-[13px] font-medium text-foreground">{title}</h3>}
			<div className="divide-y divide-border/45 overflow-hidden rounded-xl border border-border/60 bg-card">{children}</div>
		</section>
	)
}

function SettingsRow({ label, children }: { label: ReactNode; children?: ReactNode }) {
	return (
		<div className="flex min-h-[52px] items-center justify-between gap-4 px-4 py-2.5">
			<div className="shrink-0 text-sm text-foreground">{label}</div>
			{children && <div className="flex min-w-0 items-center justify-end gap-1.5 text-end">{children}</div>}
		</div>
	)
}

interface Props {
	open: boolean
	/** Null when the phone is running unpaired, on its own engine. */
	endpointId: string | null
	capabilities: Capabilities | null
	lang: string
	onLangChange: (lang: string) => void
	engineChoice: EngineChoice
	onEngineChange: (choice: EngineChoice) => void
	localModelId: string
	onLocalModelChange: (id: string) => void
	localAvailable: boolean
	onUnpair: () => void
	onClose: () => void
}

export function SettingsSheet({
	open,
	endpointId,
	capabilities,
	lang,
	onLangChange,
	engineChoice,
	onEngineChange,
	localModelId,
	onLocalModelChange,
	localAvailable,
	onUnpair,
	onClose,
}: Props) {
	if (!open) return null

	/*
		Which engine's capabilities the language controls describe. In device mode the
		desktop's reply is not just unavailable, it is the wrong answer: the phone
		runs its own model with its own language set.
	*/
	const deviceMode = engineChoice === 'device' || (engineChoice === 'auto' && !endpointId && localAvailable)
	const activeModel = LOCAL_MODELS.find((m) => m.id === localModelId) ?? LOCAL_MODELS[0]
	const effective = deviceMode ? localCapabilities(activeModel) : capabilities

	const canAuto = effective?.languageDetection ?? false
	const hasLanguages = (effective?.languages.length ?? 0) > 0

	return (
		<div className="fixed inset-0 z-50 flex items-end bg-black/50" onClick={onClose}>
			<div
				className="animate-in-smooth safe-bottom max-h-[85dvh] w-full overflow-y-auto rounded-t-3xl border-t border-border bg-card px-5 pt-5"
				onClick={(e) => e.stopPropagation()}>
				<div className="mb-5 flex items-center justify-between">
					<h2 className="text-lg font-semibold">Settings</h2>
					<Button variant="ghost" size="icon" onClick={onClose} aria-label="Close settings">
						<X />
					</Button>
				</div>

				{/*
					Grouped rows, matching the desktop app's settings: one bordered
					container per group, hairline-divided rows inside it, a 13px
					group heading above. Rows keep a 52px minimum so they stay a
					comfortable touch target.
				*/}
				<div className="mb-6 space-y-6">
					<SettingsGroup title="Desktop">
						<SettingsRow label="Paired with">
							<code className="font-mono text-xs text-muted-foreground">{endpointId ? truncateId(endpointId) : 'Not paired'}</code>
						</SettingsRow>
						{capabilities?.modelName && (
							<SettingsRow label="Model">
								<code className="font-mono text-xs break-all text-muted-foreground">{capabilities.modelName}</code>
							</SettingsRow>
						)}
					</SettingsGroup>

					<SettingsGroup title="Transcribe on">
						{!localAvailable ? (
							<p className="px-4 py-2.5 text-xs text-muted-foreground">
								This browser cannot run transcription on the device, so everything goes to the desktop. On iPhone this needs Safari on iOS 26 or
								later.
							</p>
						) : (
							<>
								{ENGINE_OPTIONS.map((option) => (
									<button
										key={option.value}
										type="button"
										className={cn(
											'flex min-h-[52px] w-full items-start justify-between gap-3 px-4 py-2.5 text-left',
											engineChoice === option.value && 'bg-accent/40',
										)}
										onClick={() => onEngineChange(option.value)}>
										<span className="min-w-0">
											<span className="block text-sm text-foreground">{option.label}</span>
											<span className="mt-0.5 block text-xs text-muted-foreground">{option.hint}</span>
										</span>
										{engineChoice === option.value && <Check className="mt-0.5 size-4 shrink-0" />}
									</button>
								))}
							</>
						)}
					</SettingsGroup>

					{localAvailable && engineChoice !== 'desktop' && (
						<SettingsGroup title="On-device model">
							{LOCAL_MODELS.map((model) => (
								<ModelRow key={model.id} model={model} selected={model.id === localModelId} onSelect={() => onLocalModelChange(model.id)} />
							))}
							<p className="px-4 py-2.5 text-xs text-muted-foreground">
								Downloaded once over the network, then kept for offline use. Add this app to your Home Screen first — Safari clears storage for
								ordinary tabs after a week.
							</p>
						</SettingsGroup>
					)}

					<SettingsGroup title="Language">
						{!hasLanguages ? (
							<p className="px-4 py-2.5 text-xs text-muted-foreground">
								The desktop has not reported any languages yet. Load a model in Vibe, then re-check.
							</p>
						) : (
							<div className="space-y-2 px-4 py-3">
								<LanguagePicker capabilities={effective} value={lang} onChange={onLangChange} />
								<p className="text-xs text-muted-foreground">
									{canAuto
										? 'Auto-detect lets the model work out the spoken language.'
										: 'This model cannot detect the language, so pick one explicitly.'}
								</p>
							</div>
						)}
					</SettingsGroup>
				</div>

				{endpointId && (
					<Button variant="destructive" className="h-12 w-full" onClick={onUnpair}>
						<Link2Off />
						Unpair this phone
					</Button>
				)}
			</div>
		</div>
	)
}
