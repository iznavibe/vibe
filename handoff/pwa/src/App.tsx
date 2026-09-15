import { useEffect, useRef, useState } from 'react'
import {
	AlertTriangle,
	Check,
	Copy,
	FolderOpen,
	HardDriveDownload,
	Mic,
	QrCode,
	RefreshCw,
	RotateCcw,
	Settings,
	Smartphone,
	Square,
	Trash2,
} from 'lucide-react'

import { InstallHint } from '~/components/install-hint'
import { OutboxCard } from '~/components/outbox-card'
import { SettingsSheet } from '~/components/settings-sheet'
import { VibeMark } from '~/components/vibe-mark'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Card, CardContent } from '~/components/ui/card'
import { Progress } from '~/components/ui/progress'
import { Spinner } from '~/components/ui/spinner'
import { basename, truncateId } from '~/lib/handoff'
import { IMPORT_ACCEPT } from '~/lib/local/import'
import { clearCrashReport, peekCrashedModelId } from '~/lib/local/crash'
import { findModel, smallerThan } from '~/lib/local/models'
import { languageLabel } from '~/lib/languages'
import { formatDuration, formatSize } from '~/lib/recorder'
import { cn } from '~/lib/style'
import { useHandoffSession } from '~/lib/use-handoff-session'

export function App() {
	// Everything below is markup: the state machine lives in the hook.
	const {
		secure,
		recordable,
		peer,
		capabilities,
		capabilitiesError,
		capabilitiesLoading,
		refreshCapabilities,
		phase,
		elapsed,
		status,
		uploadPct,
		transcribePct,
		loadingModel,
		modelPct,
		modelPhase,
		sizeWarning,
		transcript,
		savedPath,
		failure,
		activeId,
		hasRecording,
		startRecording,
		stopRecording,
		importFile,
		outbox,
		persisted,
		pumpOutbox,
		retry,
		discardQueued,
		engineChoice,
		onEngineChange,
		localModelId,
		onLocalModelChange,
		localAvailable,
		engineUsed,
		lang,
		onLangChange,
		copied,
		onCopy,
		onDiscard,
		onUnpair,
	} = useHandoffSession()

	const [settingsOpen, setSettingsOpen] = useState(false)
	const fileInput = useRef<HTMLInputElement>(null)

	/*
		A value here means the previous run did not survive loading its model —
		see `crash.ts`. The read is pure so StrictMode's double-invoke cannot
		swallow it; the breadcrumb is cleared in an effect once it has actually
		been committed to the screen.
	*/
	const [crashed, setCrashed] = useState(() => {
		const id = peekCrashedModelId()
		return id ? (findModel(id) ?? null) : null
	})

	useEffect(() => {
		if (crashed) clearCrashReport()
	}, [crashed])

	const unpair = () => {
		setSettingsOpen(false)
		onUnpair()
	}

	/**
	 * Whether this run will happen here rather than on a desktop. Mirrors the
	 * rule in `useHandoffSession.send`; the two must agree or the UI will gate
	 * on a desktop that is never going to be asked.
	 */
	const deviceMode = engineChoice === 'device' || (engineChoice === 'auto' && !peer && localAvailable)

	if (!secure) return <Shell>{<InsecureNotice />}</Shell>
	/*
		Pairing stays the default first run even on a phone that could transcribe
		by itself: the desktop is the better engine, and on-device costs a several
		hundred megabyte download that nobody should trigger by accident. So an
		unpaired phone is shown the QR instructions until it explicitly opts in,
		and only a deliberate `device` choice skips them.
	*/
	if (!peer && engineChoice !== 'device') {
		return <Shell>{<UnpairedNotice canRunLocally={localAvailable} onUseDevice={() => onEngineChange('device')} />}</Shell>
	}

	const recording = phase === 'recording'
	const busy = phase === 'sending'

	// Recording is gated on the desktop being ready, and on having a language
	// when the loaded model cannot detect one for itself.
	const modelLoaded = capabilities?.modelLoaded ?? false
	const maxBytes = capabilities?.maxAudioBytes ?? 0
	const needsExplicitLang = !!capabilities && !capabilities.languageDetection && !lang
	// On-device needs none of the desktop's preconditions: the model is fetched
	// on demand and Whisper detects the language for itself.
	const engineReady = deviceMode ? localAvailable : modelLoaded && !needsExplicitLang
	const ready = recordable && engineReady
	// Importing a file needs no microphone, so someone who declined the mic
	// prompt — or is on a device without one — can still transcribe.
	const canImport = engineReady
	const langSummary = lang ? languageLabel(lang) : 'Auto-detect'

	return (
		<Shell
			onSettings={() => setSettingsOpen(true)}
			badge={
				<Badge variant="secondary" className="font-mono text-[10px] font-normal">
					{peer ? truncateId(peer.endpointId) : 'on device'}
				</Badge>
			}>
			{!recordable && (
				<Card className="mb-4 border-destructive/40">
					<CardContent className="pt-6 text-sm text-muted-foreground">
						This browser has no <code className="font-mono">MediaRecorder</code>, so it cannot record audio. Use Safari 17+ or Chrome.
					</CardContent>
				</Card>
			)}

			{capabilitiesLoading && (
				<Card className="stagger-in mb-4">
					<CardContent className="flex items-center gap-3 pt-6 text-sm text-muted-foreground">
						<Spinner className="size-4" />
						<span>Asking your desktop what it can do…</span>
					</CardContent>
				</Card>
			)}

			{crashed && (
				<Card className="stagger-in mb-4 border-destructive/40">
					<CardContent className="space-y-3 pt-6">
						<div className="flex items-center gap-2 text-destructive">
							<AlertTriangle className="size-4" />
							<span className="eyebrow text-destructive">restarted</span>
						</div>
						<h2 className="text-base font-semibold">{crashed.label} was too much for this phone</h2>
						<p className="text-sm text-muted-foreground">
							The app restarted while loading it, which usually means it ran out of memory. Nothing was lost — but this model will probably keep
							doing it.
						</p>
						<div className="flex flex-wrap gap-2">
							{smallerThan(crashed) && (
								<Button
									className="h-12 flex-1"
									onClick={() => {
										const next = smallerThan(crashed)
										if (next) onLocalModelChange(next.id)
										setCrashed(null)
									}}>
									Switch to {smallerThan(crashed)?.label}
								</Button>
							)}
							<Button variant="outline" className="h-12 flex-1" onClick={() => setCrashed(null)}>
								Keep {crashed.label}
							</Button>
						</div>
					</CardContent>
				</Card>
			)}

			{peer && !capabilitiesLoading && capabilitiesError && (
				<Card className="stagger-in mb-4 border-destructive/40">
					<CardContent className="space-y-3 pt-6">
						<div className="flex items-center gap-2 text-destructive">
							<AlertTriangle className="size-4" />
							<span className="eyebrow text-destructive">{capabilitiesError.code}</span>
						</div>
						<p className="text-sm">{capabilitiesError.message}</p>
						{capabilitiesError.code === 'unauthorized' ? (
							<>
								<p className="text-sm text-muted-foreground">
									This pairing is no longer valid — the desktop has a new token. Unpair and scan the QR code again.
								</p>
								<Button variant="destructive" className="h-12 w-full" onClick={unpair}>
									Unpair and rescan
								</Button>
							</>
						) : (
							<Button variant="outline" className="h-12 w-full" onClick={() => peer && void refreshCapabilities(peer)}>
								<RefreshCw />
								Try again
							</Button>
						)}
					</CardContent>
				</Card>
			)}

			{peer && !capabilitiesLoading && capabilities && !capabilities.modelLoaded && (
				<Card className="stagger-in mb-4">
					<CardContent className="space-y-3 pt-6">
						<h2 className="text-base font-semibold">No model loaded</h2>
						<p className="text-sm text-muted-foreground">Load a model in Vibe on your desktop, then re-check. Recording is disabled until then.</p>
						<Button variant="outline" className="h-12 w-full" onClick={() => peer && void refreshCapabilities(peer)}>
							<RefreshCw />
							Re-check
						</Button>
					</CardContent>
				</Card>
			)}

			{needsExplicitLang && (
				<Card className="stagger-in mb-4">
					<CardContent className="space-y-3 pt-6">
						<p className="text-sm text-muted-foreground">This model cannot detect the spoken language. Choose one before recording.</p>
						<Button variant="outline" className="h-12 w-full" onClick={() => setSettingsOpen(true)}>
							Choose a language
						</Button>
					</CardContent>
				</Card>
			)}

			<OutboxCard entries={outbox} activeId={activeId} busy={busy} persisted={persisted} onSendNow={() => void pumpOutbox()} onDelete={discardQueued} />

			<div className="flex flex-col items-center py-8">
				<button
					type="button"
					disabled={!ready || busy}
					onClick={recording ? stopRecording : () => void startRecording()}
					aria-label={recording ? 'Stop recording' : 'Start recording'}
					className={cn(
						'flex size-44 flex-col items-center justify-center gap-3 rounded-full text-lg font-semibold shadow-lg transition-transform duration-150 active:scale-[0.97] disabled:opacity-50',
						recording ? 'record-pulse bg-destructive text-destructive-foreground' : 'bg-primary text-primary-foreground',
					)}>
					{recording ? <Square className="size-9 fill-current" /> : <Mic className="size-10" />}
					<span>{recording ? 'Stop' : 'Record'}</span>
				</button>

				<div className="mt-5 h-8 text-3xl font-semibold tabular-nums">{recording ? formatDuration(elapsed) : ''}</div>
				{recording && sizeWarning && maxBytes > 0 && (
					<p className="mt-1 text-center text-xs text-destructive">
						Approaching your desktop's {formatSize(maxBytes)} limit — recording will stop there.
					</p>
				)}
				<p className="text-sm text-muted-foreground">{recording ? 'Keep this screen open.' : 'Tap to record, tap again to send.'}</p>

				{/*
					Importing is hidden while recording or busy: the run is sequential,
					and a second source picked mid-run would be silently dropped by the
					re-entrancy guard, which reads as the button not working.
				*/}
				{!recording && !busy && (
					<>
						<input
							ref={fileInput}
							type="file"
							accept={IMPORT_ACCEPT}
							className="hidden"
							onChange={(e) => {
								const file = e.target.files?.[0]
								// Cleared so picking the same file twice in a row still
								// fires a change event.
								e.target.value = ''
								if (file) void importFile(file)
							}}
						/>
						<Button variant="ghost" className="mt-4 h-11" disabled={!canImport} onClick={() => fileInput.current?.click()}>
							<FolderOpen />
							Choose audio or video
						</Button>
					</>
				)}

				{capabilities?.modelLoaded && (
					<p className="mt-3 text-center text-xs text-muted-foreground">
						{langSummary}
						{capabilities.modelName && (
							<>
								{' · '}
								<code className="font-mono">{capabilities.modelName}</code>
							</>
						)}
					</p>
				)}
			</div>

			{(busy || status || uploadPct !== null || failure) && (
				<Card className="stagger-in mb-4">
					<CardContent className="space-y-4 pt-6">
						{status && (
							<div className="flex items-center gap-2 text-sm">
								{busy && <Spinner className="size-4" />}
								<span>{status}</span>
							</div>
						)}

						{busy && <p className="text-xs text-muted-foreground">Keep this screen open until the transcript arrives.</p>}

						{uploadPct !== null && <Meter label="Upload" value={uploadPct} />}
						{modelPhase && modelPct !== null && (
							<Meter label={modelPhase === 'downloading' ? 'Downloading model' : 'Loading model'} value={modelPct} />
						)}
						{loadingModel && <IndeterminateMeter label="Loading model" />}
						{transcribePct !== null && <Meter label="Transcribing" value={transcribePct} />}

						{failure && (
							<div className="rounded-xl border border-destructive/40 bg-destructive/10 p-4">
								<div className="mb-1 flex items-center gap-2 text-destructive">
									<AlertTriangle className="size-4" />
									<span className="eyebrow text-destructive">{failure.code}</span>
								</div>
								<p className="text-sm">{failure.message}</p>
							</div>
						)}

						{/*
							Which engine produced this. Not decoration: the desktop runs a
							larger model through a different runtime, so two transcripts of
							the same audio can differ, and the user should be able to tell
							which one they are reading before they go looking for a bug.
						*/}
						{phase === 'done' && engineUsed === 'device' && (
							<div className="flex items-start gap-2 text-xs text-muted-foreground">
								<Smartphone className="mt-0.5 size-3.5 shrink-0" />
								<span>Transcribed on this phone. Your desktop would use a larger model.</span>
							</div>
						)}

						{phase === 'done' && savedPath && (
							<div className="flex items-start gap-2 text-xs text-muted-foreground">
								<HardDriveDownload className="mt-0.5 size-3.5 shrink-0" />
								<span>
									Saved on your desktop as <code className="font-mono break-all">{basename(savedPath)}</code>
								</span>
							</div>
						)}

						{(failure || phase === 'done') && (
							<div className="flex flex-wrap gap-2">
								{failure && hasRecording && (
									<Button className="h-12 flex-1" onClick={() => void retry()}>
										<RotateCcw />
										Retry
									</Button>
								)}
								<Button variant="outline" className="h-12 flex-1" onClick={onDiscard}>
									<Trash2 />
									Discard
								</Button>
							</div>
						)}
					</CardContent>
				</Card>
			)}

			{transcript && (
				<Card className="stagger-in mb-4">
					<CardContent className="pt-6">
						<div className="mb-3 flex items-center justify-between">
							<span className="eyebrow">Transcript</span>
							<Button variant="ghost" size="sm" onClick={() => void onCopy()}>
								{copied ? <Check /> : <Copy />}
								{copied ? 'Copied' : 'Copy'}
							</Button>
						</div>
						<p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed">{transcript}</p>
					</CardContent>
				</Card>
			)}

			<InstallHint variant="subtle" />

			<SettingsSheet
				open={settingsOpen}
				endpointId={peer?.endpointId ?? null}
				capabilities={capabilities}
				lang={lang}
				onLangChange={onLangChange}
				engineChoice={engineChoice}
				onEngineChange={onEngineChange}
				localModelId={localModelId}
				onLocalModelChange={onLocalModelChange}
				localAvailable={localAvailable}
				onUnpair={unpair}
				onClose={() => setSettingsOpen(false)}
			/>
		</Shell>
	)
}

function Meter({ label, value }: { label: string; value: number }) {
	return (
		<div className="space-y-1.5">
			<div className="flex items-center justify-between text-xs text-muted-foreground">
				<span>{label}</span>
				<span className="tabular-nums">{value}%</span>
			</div>
			<Progress value={value} className="progress-aurora h-2" />
		</div>
	)
}

/** For work with no reportable percentage — the desktop loading a model. */
function IndeterminateMeter({ label }: { label: string }) {
	return (
		<div className="space-y-1.5">
			<div className="flex items-center justify-between text-xs text-muted-foreground">
				<span>{label}</span>
				<span>this can take a while</span>
			</div>
			<div className="bg-primary/20 relative h-2 w-full overflow-hidden rounded-full">
				<div className="aurora-bar handoff-sweep h-full w-1/3 rounded-full" />
			</div>
		</div>
	)
}

function Shell({ children, onSettings, badge }: { children: React.ReactNode; onSettings?: () => void; badge?: React.ReactNode }) {
	return (
		<div className="safe-bottom mx-auto flex min-h-dvh w-full max-w-md flex-col px-4">
			<header className="safe-top flex items-center justify-between pb-2">
				<div className="flex min-w-0 items-center gap-2">
					<VibeMark className="size-6" />
					<h1 className="text-base font-semibold">
						Vibe <span className="font-normal text-muted-foreground">Phone</span>
					</h1>
					{badge}
				</div>
				{onSettings && (
					<Button variant="ghost" size="icon" onClick={onSettings} aria-label="Settings">
						<Settings />
					</Button>
				)}
			</header>
			<main className="flex-1">{children}</main>
		</div>
	)
}

function UnpairedNotice({ canRunLocally, onUseDevice }: { canRunLocally: boolean; onUseDevice: () => void }) {
	return (
		<div className="mt-10 space-y-4">
			<Card className="stagger-in">
				<CardContent className="flex flex-col items-center gap-4 py-10 text-center">
					<div className="aurora flex size-20 items-center justify-center rounded-2xl">
						<QrCode className="size-9" />
					</div>
					<div>
						<h2 className="text-lg font-semibold">Not paired yet</h2>
						<p className="mt-1 text-sm text-muted-foreground">
							Scan the QR code in Vibe &rarr; Settings &rarr; Phone to link this device to your desktop.
						</p>
						<p className="mt-3 text-xs text-muted-foreground">
							Paired before and seeing this? Scanning the QR code again is all it takes — it re-pairs in one step.
						</p>
					</div>
					{canRunLocally ? (
						<div className="w-full border-t pt-4">
							<p className="text-sm text-muted-foreground">Or skip the desktop entirely and transcribe on this phone.</p>
							<Button variant="secondary" className="mt-3" onClick={onUseDevice}>
								Transcribe on this device
							</Button>
							<p className="mt-2 text-xs text-muted-foreground">Downloads a model once, then works offline. Slower than your desktop.</p>
						</div>
					) : null}
				</CardContent>
			</Card>
			<InstallHint variant="pre-pairing" />
		</div>
	)
}

function InsecureNotice() {
	return (
		<Card className="stagger-in mt-10 border-destructive/40">
			<CardContent className="flex flex-col gap-3 py-8">
				<div className="flex items-center gap-2 text-destructive">
					<AlertTriangle className="size-5" />
					<h2 className="text-base font-semibold">Insecure connection</h2>
				</div>
				<p className="text-sm text-muted-foreground">
					Microphone access needs HTTPS or <code className="font-mono">localhost</code>. This page was served over plain HTTP from{' '}
					<code className="font-mono break-all">{location.origin}</code>, so recording is disabled.
				</p>
				<p className="text-sm text-muted-foreground">
					Open it on the desktop at <code className="font-mono">http://localhost:8088</code>, or put the app behind HTTPS (or a tunnel) before testing
					on a phone.
				</p>
			</CardContent>
		</Card>
	)
}
