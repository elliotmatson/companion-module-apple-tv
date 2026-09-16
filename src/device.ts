import {
	AppleTV,
	Credentials,
	Key,
	PlaybackState,
	scan,
	type HAPCredentials,
	type NowPlayingInfo,
	type OpackDict,
} from 'node-appletv-remote'

export { Key, PlaybackState }

export interface DeviceTarget {
	host: string
	port: number
	companionPort: number
	useCompanion: boolean
	reconnectIntervalMs: number
	pollIntervalMs: number
}

export interface DeviceState {
	connected: boolean
	companionConnected: boolean
	name: string
	model: string
	host: string

	playbackState: PlaybackState
	title: string
	artist: string
	album: string
	appName: string
	appBundleId: string

	duration: number
	/** Elapsed position at the moment `elapsedAt` was captured */
	elapsedBase: number
	elapsedAt: number
	playbackRate: number
}

export interface DeviceHost {
	log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void
	onConnectionChanged(): void
	onStateChanged(): void
}

const emptyMedia = {
	playbackState: PlaybackState.Unknown,
	title: '',
	artist: '',
	album: '',
	appName: '',
	appBundleId: '',
	duration: 0,
	elapsedBase: 0,
	elapsedAt: 0,
	playbackRate: 0,
}

/** An unreachable host would otherwise sit in the OS TCP timeout for well over a minute. */
const CONNECT_TIMEOUT_MS = 20000
const PAIR_TIMEOUT_MS = 15000

/** The pairing flow is two steps, so the in-progress session has to live somewhere between saves. */
interface PendingPairing {
	protocol: 'airplay' | 'companion'
	finish: (pin: string) => Promise<HAPCredentials>
	destroy: () => void
}

/**
 * Owns the connection to a single Apple TV: connecting, reconnecting, pairing and
 * the cached now-playing state. Everything Companion-specific stays in the module.
 */
export class AppleTvDevice {
	readonly #host: DeviceHost

	#atv: AppleTV | undefined
	#target: DeviceTarget | undefined
	#credentials: Credentials | undefined

	#reconnectTimer: NodeJS.Timeout | undefined
	#pollTimer: NodeJS.Timeout | undefined
	#connecting = false
	#destroyed = false

	#pending: PendingPairing | undefined

	state: DeviceState = {
		connected: false,
		companionConnected: false,
		name: '',
		model: '',
		host: '',
		...emptyMedia,
	}

	constructor(host: DeviceHost) {
		this.#host = host
	}

	get isConnected(): boolean {
		return this.state.connected
	}

	get isCompanionConnected(): boolean {
		return this.state.companionConnected
	}

	get hasPendingPairing(): boolean {
		return this.#pending !== undefined
	}

	/** Position in seconds, extrapolated from the last update using the playback rate. */
	get elapsed(): number {
		const { elapsedBase, elapsedAt, playbackRate, duration } = this.state
		if (elapsedAt === 0) return 0

		const drift = playbackRate !== 0 ? ((Date.now() - elapsedAt) / 1000) * playbackRate : 0
		const value = elapsedBase + drift
		if (duration > 0 && value > duration) return duration
		return value > 0 ? value : 0
	}

	// --- Lifecycle -------------------------------------------------------------

	/**
	 * Connecting can take a while, so it runs in the background and reports through the host
	 * callbacks. Blocking here would stall the module's `init`/`configUpdated`.
	 */
	async start(target: DeviceTarget, credentials: Credentials | undefined): Promise<void> {
		await this.stop()

		this.#destroyed = false
		this.#target = target
		this.#credentials = credentials
		this.state.host = target.host

		void this.connect()
	}

	async stop(): Promise<void> {
		this.#destroyed = true
		this.#clearTimers()
		this.#cancelPairing()

		const atv = this.#atv
		this.#atv = undefined
		if (atv) {
			atv.removeAllListeners()
			try {
				await atv.close()
			} catch (e) {
				this.#host.log('debug', `Error closing connection: ${errorMessage(e)}`)
			}
		}

		this.#setConnected(false, false)
	}

	async connect(): Promise<void> {
		const target = this.#target
		if (!target || this.#destroyed || this.#connecting) return
		if (!this.#credentials) return

		this.#connecting = true
		this.#clearTimers()

		try {
			// Bonjour fills in the friendly name, model and the companion-link port, none of
			// which can be derived from the address alone. A failed scan is not fatal.
			const info = await this.#discover(target)

			const atv = new AppleTV(info)
			this.#atv = atv
			this.#attachListeners(atv)

			try {
				await withTimeout(atv.connect(this.#credentials), CONNECT_TIMEOUT_MS, `connect to ${target.host}`)
			} catch (e) {
				// An abandoned socket would keep the OS TCP timeout running in the background.
				await atv.close().catch(() => undefined)
				throw e
			}

			this.state.name = info.name
			this.state.model = info.model
			this.#setConnected(true, this.state.companionConnected)
			this.#host.log('info', `Connected to ${info.name || target.host} (${info.model || 'Apple TV'})`)

			// Bonjour lists every AirPlay receiver, including Macs and third-party TVs, which
			// accept the connection but ignore most remote commands.
			if (info.model && !info.model.startsWith('AppleTV')) {
				this.#host.log('warn', `${info.model} is an AirPlay receiver but not an Apple TV; commands may be ignored`)
			}

			if (target.useCompanion) await this.#connectCompanion(atv, this.#credentials)

			this.#startPolling()
			void this.refreshState()
		} catch (e) {
			this.#host.log('error', `Connection failed: ${errorMessage(e)}`)
			this.#setConnected(false, false)
			this.#scheduleReconnect()
		} finally {
			this.#connecting = false
		}
	}

	async #discover(target: DeviceTarget): Promise<{
		name: string
		address: string
		port: number
		deviceId: string
		model: string
		companionPort?: number
	}> {
		const fallback = {
			name: this.state.name,
			address: target.host,
			port: target.port,
			deviceId: '',
			model: this.state.model,
			companionPort: target.companionPort > 0 ? target.companionPort : undefined,
		}

		// Only worth the mDNS round trip when we are missing something it can tell us.
		const needsCompanionPort = target.useCompanion && target.companionPort <= 0
		if (!needsCompanionPort && fallback.name) return fallback

		try {
			const devices = await scan({ timeout: 4000, filter: (d) => d.address === target.host })
			const found = devices[0]
			if (!found) {
				this.#host.log('debug', `Bonjour did not return ${target.host}, using the configured values`)
				return fallback
			}
			return {
				name: found.name,
				address: target.host,
				port: target.port || found.port,
				deviceId: found.deviceId,
				model: found.model,
				companionPort: target.companionPort > 0 ? target.companionPort : found.companionPort,
			}
		} catch (e) {
			this.#host.log('debug', `Bonjour scan failed: ${errorMessage(e)}`)
			return fallback
		}
	}

	async #connectCompanion(atv: AppleTV, credentials: Credentials): Promise<void> {
		const companionCreds = credentials.companionCredentials
		if (!companionCreds) {
			this.#host.log('warn', 'Companion Link is enabled but no Companion Link credentials are stored')
			return
		}

		try {
			await atv.connectCompanion(companionCreds)
			this.#setConnected(this.state.connected, true)
			this.#host.log('info', 'Companion Link connected')
		} catch (e) {
			this.#host.log('warn', `Companion Link connection failed: ${errorMessage(e)}`)
			this.#setConnected(this.state.connected, false)
		}
	}

	#attachListeners(atv: AppleTV): void {
		atv.on('error', (err: Error) => {
			this.#host.log('error', `Apple TV error: ${errorMessage(err)}`)
		})
		atv.on('close', () => {
			if (this.#atv !== atv) return
			this.#host.log('info', 'Connection closed')
			this.#setConnected(false, false)
			this.#scheduleReconnect()
		})
		atv.on('companionClose', () => {
			if (this.#atv !== atv) return
			this.#setConnected(this.state.connected, false)
		})
		atv.on('companionError', (err: Error) => {
			this.#host.log('warn', `Companion Link error: ${errorMessage(err)}`)
		})
		atv.on('nowPlaying', (info: NowPlayingInfo) => {
			this.#applyNowPlaying(info)
		})
		atv.on('message', (msg: { type: number; payload: Record<string, unknown> }) => {
			this.#applyRawMessage(msg)
		})
	}

	#scheduleReconnect(): void {
		if (this.#destroyed || this.#reconnectTimer) return
		const delay = this.#target?.reconnectIntervalMs ?? 10000

		this.#reconnectTimer = setTimeout(() => {
			this.#reconnectTimer = undefined
			void this.connect()
		}, delay)
	}

	#startPolling(): void {
		const interval = this.#target?.pollIntervalMs ?? 0
		if (interval <= 0) return

		this.#pollTimer = setInterval(() => {
			void this.refreshState()
		}, interval)
	}

	#clearTimers(): void {
		if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer)
		if (this.#pollTimer) clearInterval(this.#pollTimer)
		this.#reconnectTimer = undefined
		this.#pollTimer = undefined
	}

	#setConnected(connected: boolean, companionConnected: boolean): void {
		const changed = this.state.connected !== connected || this.state.companionConnected !== companionConnected
		this.state.connected = connected
		this.state.companionConnected = companionConnected

		if (!connected) Object.assign(this.state, emptyMedia)
		if (changed) this.#host.onConnectionChanged()
	}

	// --- State -----------------------------------------------------------------

	/** Ask the Apple TV for the current now-playing item. */
	async refreshState(): Promise<void> {
		const atv = this.#atv
		if (!atv || !this.state.connected) return

		try {
			const response = await atv.getState()
			this.#applyRawMessage({ type: 4, payload: response })
		} catch (e) {
			this.#host.log('debug', `State request failed: ${errorMessage(e)}`)
		}
	}

	#applyNowPlaying(info: NowPlayingInfo): void {
		this.state.playbackState = info.playbackState
		this.state.title = info.title
		this.state.artist = info.artist
		this.state.album = info.album
		this.state.duration = info.duration
		this.state.elapsedBase = info.elapsedTime
		this.state.elapsedAt = Date.now()
		this.state.playbackRate = info.playbackRate
		if (info.appDisplayName) this.state.appName = info.appDisplayName

		this.#host.onStateChanged()
	}

	/**
	 * SetState messages carry more than the `nowPlaying` event exposes — notably the bundle
	 * identifier of the foreground app and the metadata returned by a playback queue request.
	 */
	#applyRawMessage(msg: { type: number; payload: Record<string, unknown> }): void {
		if (msg.type !== 4) return

		const setState = asRecord(msg.payload['.setStateMessage'])
		if (!setState) return

		let changed = false

		const client = asRecord(asRecord(setState.playerPath)?.client)
		if (client) {
			const bundleId = asString(client.bundleIdentifier)
			const displayName = asString(client.displayName)
			if (bundleId && bundleId !== this.state.appBundleId) {
				this.state.appBundleId = bundleId
				changed = true
			}
			if (displayName && displayName !== this.state.appName) {
				this.state.appName = displayName
				changed = true
			}
		}

		const displayName = asString(setState.displayName)
		if (displayName && displayName !== this.state.appName) {
			this.state.appName = displayName
			changed = true
		}

		const reportedState = asPlaybackState(setState.playbackState)
		if (reportedState !== undefined && reportedState !== this.state.playbackState) {
			this.state.playbackState = reportedState
			changed = true
		}

		const items = asRecord(setState.playbackQueue)?.contentItems
		const metadata = Array.isArray(items) ? asRecord(asRecord(items[0])?.metadata) : undefined
		if (metadata) {
			this.state.title = asString(metadata.title) ?? ''
			this.state.artist = asString(metadata.trackArtistName) ?? asString(metadata.albumArtistName) ?? ''
			this.state.album = asString(metadata.albumName) ?? ''
			this.state.duration = asNumber(metadata.duration) ?? 0
			this.state.elapsedBase = asNumber(metadata.elapsedTime) ?? 0
			this.state.elapsedAt = Date.now()
			this.state.playbackRate = asNumber(metadata.playbackRate) ?? 0

			// A queue response has no playbackState field, so derive it from the rate.
			if (reportedState === undefined) {
				this.state.playbackState = this.state.playbackRate > 0 ? PlaybackState.Playing : PlaybackState.Paused
			}
			changed = true
		}

		if (changed) this.#host.onStateChanged()
	}

	// --- Commands --------------------------------------------------------------

	#requireConnection(): AppleTV {
		const atv = this.#atv
		if (!atv || !this.state.connected) throw new Error('Not connected to the Apple TV')
		return atv
	}

	async sendKey(key: Key): Promise<void> {
		await this.#requireConnection().sendKeyCommand(key)
	}

	async stopPlayback(): Promise<void> {
		await this.#requireConnection().stop()
	}

	async sendText(text: string, mode: 'set' | 'insert'): Promise<void> {
		const atv = this.#requireConnection()
		if (mode === 'set') await atv.setText(text)
		else await atv.insertText(text)
	}

	async clearText(): Promise<void> {
		await this.#requireConnection().clearText()
	}

	async deleteText(): Promise<void> {
		await this.#requireConnection().deleteText()
	}

	async companionRequest(identifier: string, content: OpackDict): Promise<OpackDict> {
		const atv = this.#atv
		if (!atv || !this.state.companionConnected) throw new Error('Companion Link is not connected')
		return atv.sendCompanionRequest(identifier, content)
	}

	async launchApp(bundleId: string): Promise<void> {
		const content: OpackDict = new Map()
		content.set('_bundleID', bundleId)
		await this.companionRequest('_launchApp', content)
	}

	// --- Pairing ---------------------------------------------------------------

	/** Step one: ask the Apple TV to display a PIN. */
	async beginPairing(protocol: 'airplay' | 'companion', target: DeviceTarget): Promise<void> {
		this.#cancelPairing()

		// AirPlay pairing needs nothing Bonjour could add, so skip the scan and its delay.
		const info =
			protocol === 'companion'
				? await this.#discover({ ...target, useCompanion: true })
				: { name: '', address: target.host, port: target.port, deviceId: '', model: '' }

		const atv = new AppleTV(info)
		atv.on('error', () => {
			/* pairing sockets report through the rejected promise instead */
		})

		if (protocol === 'companion') {
			if (!info.companionPort) {
				throw new Error('Could not find the Companion Link port. Set it manually in the module config.')
			}
			const session = await withTimeout(
				atv.startCompanionPairing({ companionPort: info.companionPort }),
				PAIR_TIMEOUT_MS,
				`request a PIN from ${target.host}`,
			)
			this.#pending = {
				protocol,
				finish: async (pin) => session.finish(pin),
				destroy: () => session.destroy(),
			}
		} else {
			const session = await withTimeout(atv.startPairing(), PAIR_TIMEOUT_MS, `request a PIN from ${target.host}`)
			this.#pending = {
				protocol,
				finish: async (pin) => session.finish(pin),
				destroy: () => session.destroy(),
			}
		}
	}

	/**
	 * Step two: exchange the PIN for long-term credentials. AirPlay and Companion Link
	 * credentials are kept side by side so both transports can be used at once.
	 */
	async completePairing(pin: string, existing: Credentials | undefined): Promise<Credentials> {
		const pending = this.#pending
		if (!pending) throw new Error('Pairing has not been started')

		try {
			const creds = await withTimeout(pending.finish(pin), PAIR_TIMEOUT_MS, 'complete pairing')

			if (pending.protocol === 'companion') {
				if (existing) {
					existing.companionCredentials = creds
					return existing
				}
				return new Credentials(creds, creds)
			}

			return new Credentials(creds, existing?.companionCredentials)
		} finally {
			this.#cancelPairing()
		}
	}

	#cancelPairing(): void {
		const pending = this.#pending
		this.#pending = undefined
		if (!pending) return

		try {
			pending.destroy()
		} catch {
			// the socket may already be gone
		}
	}
}

/** Rejects with a readable error rather than waiting on whatever timeout the socket has. */
async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`Timed out after ${Math.round(ms / 1000)}s trying to ${what}`)), ms)
	})

	try {
		return await Promise.race([promise, timeout])
	} finally {
		if (timer) clearTimeout(timer)
	}
}

export function errorMessage(e: unknown): string {
	if (e instanceof Error) return e.message
	return String(e)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined
}

function asNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

const KNOWN_PLAYBACK_STATES: Record<number, PlaybackState | undefined> = {
	[PlaybackState.Unknown]: PlaybackState.Unknown,
	[PlaybackState.Playing]: PlaybackState.Playing,
	[PlaybackState.Paused]: PlaybackState.Paused,
	[PlaybackState.Stopped]: PlaybackState.Stopped,
	[PlaybackState.Interrupted]: PlaybackState.Interrupted,
	[PlaybackState.Seeking]: PlaybackState.Seeking,
}

function asPlaybackState(value: unknown): PlaybackState | undefined {
	const num = asNumber(value)
	if (num === undefined) return undefined

	return KNOWN_PLAYBACK_STATES[num] ?? PlaybackState.Unknown
}
