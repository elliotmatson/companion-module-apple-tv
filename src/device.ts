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
import type { RemoteKeyId } from './actions.js'

export { Key, PlaybackState }

export type Transport = 'airplay' | 'companion' | 'both'

/** An unreachable host would otherwise sit in the OS TCP timeout for well over a minute. */
const CONNECT_TIMEOUT_MS = 20000
const PAIR_TIMEOUT_MS = 15000

/**
 * HID usage codes accepted by the Companion Link `_hidC` command, as documented by pyatv.
 * Only the keys Companion Link can express are listed; the rest need the AirPlay transport.
 */
const COMPANION_HID_CODES: Partial<Record<RemoteKeyId, number>> = {
	up: 1,
	down: 2,
	left: 3,
	right: 4,
	menu: 5,
	select: 6,
	home: 7,
	home_hold: 7,
	volume_up: 8,
	volume_down: 9,
	suspend: 12,
	wake: 13,
	play_pause: 14,
}

export interface DeviceTarget {
	host: string
	port: number
	/** Companion Link is usually on the same host, but the two are discovered separately. */
	companionHost: string
	/** 0 = discover the companion-link port over mDNS */
	companionPort: number
	transport: Transport
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

/** The pairing flow is two steps, so the in-progress session has to live somewhere between saves. */
interface PendingPairing {
	protocol: 'airplay' | 'companion'
	finish: (pin: string) => Promise<HAPCredentials>
	destroy: () => void
}

interface DiscoveredInfo {
	name: string
	address: string
	port: number
	deviceId: string
	model: string
	companionPort?: number
}

/**
 * Owns the connection to a single Apple TV. AirPlay and Companion Link are connected,
 * retried and reported independently, so losing one does not disturb the other.
 */
export class AppleTvDevice {
	readonly #host: DeviceHost

	#atv: AppleTV | undefined
	#target: DeviceTarget | undefined
	#credentials: Credentials | undefined

	#airplayTimer: NodeJS.Timeout | undefined
	#companionTimer: NodeJS.Timeout | undefined
	#pollTimer: NodeJS.Timeout | undefined
	#airplayConnecting = false
	#companionConnecting = false
	#destroyed = true
	#stateRequestFailed = false

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

	/** True when at least one transport is up, which is all most actions need. */
	get isOnline(): boolean {
		return this.state.connected || this.state.companionConnected
	}

	get hasPendingPairing(): boolean {
		return this.#pending !== undefined
	}

	get wantsAirplay(): boolean {
		return this.#target !== undefined && this.#target.transport !== 'companion'
	}

	get wantsCompanion(): boolean {
		if (!this.#target || this.#target.transport === 'airplay') return false
		return this.#credentials?.companionCredentials !== undefined
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

		void this.#openConnections()
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

	async #openConnections(): Promise<void> {
		const target = this.#target
		const credentials = this.#credentials
		if (!target || !credentials || this.#destroyed) return

		try {
			const info = await this.#discover(target)
			if (this.#destroyed) return

			const atv = new AppleTV(info)
			this.#atv = atv
			this.#attachListeners(atv)

			this.state.name = info.name
			this.state.model = info.model

			// Bonjour lists every AirPlay receiver, including Macs and third-party TVs, which
			// accept the connection but ignore most remote commands.
			if (info.model && !info.model.startsWith('AppleTV')) {
				this.#host.log('warn', `${info.model} is an AirPlay receiver but not an Apple TV; commands may be ignored`)
			}
		} catch (e) {
			this.#host.log('error', `Could not prepare the connection: ${errorMessage(e)}`)
			this.#scheduleAirplayRetry()
			return
		}

		// Each transport stands on its own — one failing must not block the other.
		await Promise.all([this.connectAirplay(), this.connectCompanion()])
	}

	async connectAirplay(): Promise<void> {
		const atv = this.#atv
		const target = this.#target
		const credentials = this.#credentials
		if (!atv || !target || !credentials || this.#destroyed) return
		if (!this.wantsAirplay || this.state.connected || this.#airplayConnecting) return

		this.#airplayConnecting = true
		if (this.#airplayTimer) clearTimeout(this.#airplayTimer)
		this.#airplayTimer = undefined

		try {
			try {
				await withTimeout(atv.connect(credentials), CONNECT_TIMEOUT_MS, `connect to ${target.host}`)
			} catch (e) {
				// An abandoned socket would keep the OS TCP timeout running in the background.
				await atv.close().catch(() => undefined)
				throw e
			}

			this.#setConnected(true, this.state.companionConnected)
			this.#host.log('info', `AirPlay connected to ${this.state.name || target.host}`)

			this.#startPolling()
			// The Apple TV needs a moment after the data channel opens before it answers queries.
			setTimeout(() => void this.refreshState(), 1500)
		} catch (e) {
			this.#host.log('error', `AirPlay connection failed: ${errorMessage(e)}`)
			this.#setConnected(false, this.state.companionConnected)
			this.#scheduleAirplayRetry()
		} finally {
			this.#airplayConnecting = false
		}
	}

	async connectCompanion(): Promise<void> {
		const atv = this.#atv
		const target = this.#target
		if (!atv || !target || this.#destroyed) return
		if (target.transport === 'airplay') return
		if (this.state.companionConnected || this.#companionConnecting) return

		const companionCreds = this.#credentials?.companionCredentials
		if (!companionCreds) {
			// 'both' is the default, so a missing Companion Link pairing is normal, not an error.
			const message = 'Companion Link has not been paired yet'
			if (target.transport === 'companion') this.#host.log('error', message)
			else this.#host.log('debug', message)
			return
		}

		const port = atv.companionPort ?? (target.companionPort > 0 ? target.companionPort : undefined)
		if (!port) {
			this.#host.log('warn', 'Could not find the Companion Link port; set it manually in the module config')
			return
		}

		// Both connections are made to the AirPlay address, so picking a Companion Link device
		// on a different host would quietly talk to the wrong Apple TV.
		if (target.companionHost !== target.host) {
			this.#host.log(
				'warn',
				`Companion Link was selected on ${target.companionHost} but the connection is to ${target.host}; ` +
					'pick the matching device or the wrong Apple TV may respond',
			)
		}

		this.#companionConnecting = true
		if (this.#companionTimer) clearTimeout(this.#companionTimer)
		this.#companionTimer = undefined

		try {
			await withTimeout(
				atv.connectCompanion(companionCreds, port),
				CONNECT_TIMEOUT_MS,
				`connect to Companion Link on ${target.companionHost}:${port}`,
			)

			this.#setConnected(this.state.connected, true)
			this.#host.log('info', 'Companion Link connected')

			await this.#startCompanionSession()
		} catch (e) {
			this.#host.log('warn', `Companion Link connection failed: ${errorMessage(e)}`)
			this.#setConnected(this.state.connected, false)
			this.#scheduleCompanionRetry()
		} finally {
			this.#companionConnecting = false
		}
	}

	/**
	 * pyatv opens a session before issuing remote commands. Neither request is required for the
	 * connection itself, so a failure here is logged and otherwise ignored.
	 */
	async #startCompanionSession(): Promise<void> {
		const atv = this.#atv
		if (!atv) return

		try {
			const info: OpackDict = new Map()
			info.set('_pubID', this.#credentials?.companionCredentials?.clientId ?? 'companion')
			info.set('name', 'Bitfocus Companion')
			info.set('model', 'Companion')
			await atv.sendCompanionRequest('_systemInfo', info)
		} catch (e) {
			this.#host.log('debug', `Companion Link _systemInfo failed: ${errorMessage(e)}`)
		}

		try {
			const content: OpackDict = new Map()
			content.set('_srvT', 'com.apple.tvremoteservices')
			content.set('_sid', Math.floor(Math.random() * 0xffffffff))
			await atv.sendCompanionRequest('_sessionStart', content)
		} catch (e) {
			this.#host.log('debug', `Companion Link _sessionStart failed: ${errorMessage(e)}`)
		}
	}

	async #discover(target: DeviceTarget): Promise<DiscoveredInfo> {
		const fallback: DiscoveredInfo = {
			name: this.state.name,
			address: target.host,
			port: target.port,
			deviceId: '',
			model: this.state.model,
			companionPort: target.companionPort > 0 ? target.companionPort : undefined,
		}

		// Only worth the mDNS round trip when we are missing something it can tell us.
		const needsCompanionPort = target.transport !== 'airplay' && target.companionPort <= 0
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

	#attachListeners(atv: AppleTV): void {
		atv.on('error', (err: Error) => {
			this.#host.log('error', `Apple TV error: ${errorMessage(err)}`)
		})
		atv.on('close', () => {
			if (this.#atv !== atv || !this.state.connected) return
			this.#host.log('info', 'AirPlay connection closed')
			this.#setConnected(false, this.state.companionConnected)
			this.#stopPolling()
			this.#scheduleAirplayRetry()
		})
		atv.on('companionClose', () => {
			if (this.#atv !== atv || !this.state.companionConnected) return
			this.#host.log('info', 'Companion Link connection closed')
			this.#setConnected(this.state.connected, false)
			this.#scheduleCompanionRetry()
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

	#scheduleAirplayRetry(): void {
		if (this.#destroyed || this.#airplayTimer || !this.wantsAirplay) return

		this.#airplayTimer = setTimeout(() => {
			this.#airplayTimer = undefined
			void this.connectAirplay()
		}, this.#target?.reconnectIntervalMs ?? 10000)
	}

	#scheduleCompanionRetry(): void {
		if (this.#destroyed || this.#companionTimer || !this.wantsCompanion) return

		this.#companionTimer = setTimeout(() => {
			this.#companionTimer = undefined
			void this.connectCompanion()
		}, this.#target?.reconnectIntervalMs ?? 10000)
	}

	#startPolling(): void {
		this.#stopPolling()

		const interval = this.#target?.pollIntervalMs ?? 0
		if (interval <= 0) return

		this.#pollTimer = setInterval(() => {
			void this.refreshState()
		}, interval)
	}

	#stopPolling(): void {
		if (this.#pollTimer) clearInterval(this.#pollTimer)
		this.#pollTimer = undefined
	}

	#clearTimers(): void {
		if (this.#airplayTimer) clearTimeout(this.#airplayTimer)
		if (this.#companionTimer) clearTimeout(this.#companionTimer)
		this.#airplayTimer = undefined
		this.#companionTimer = undefined
		this.#stopPolling()
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
			this.#stateRequestFailed = false
			this.#applyRawMessage({ type: 4, payload: response })
		} catch (e) {
			// An idle Apple TV simply never answers, so only mention it when the status changes.
			if (!this.#stateRequestFailed) {
				this.#stateRequestFailed = true
				this.#host.log('debug', `State request got no answer (nothing playing?): ${errorMessage(e)}`)
			}
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

	#requireAirplay(what: string): AppleTV {
		const atv = this.#atv
		if (!atv || !this.state.connected) {
			throw new Error(
				this.state.companionConnected
					? `${what} needs the AirPlay connection, which is not available`
					: 'Not connected to the Apple TV',
			)
		}
		return atv
	}

	/** Prefers AirPlay, falling back to the Companion Link HID commands when it is the only link. */
	async sendKey(key: RemoteKeyId): Promise<void> {
		const atv = this.#atv

		if (atv && this.state.connected) {
			if (key === 'stop') await atv.stop()
			else await atv.sendKeyCommand(key as Key)
			return
		}

		if (atv && this.state.companionConnected) {
			await this.#sendCompanionKey(key)
			return
		}

		throw new Error('Not connected to the Apple TV')
	}

	async #sendCompanionKey(key: RemoteKeyId): Promise<void> {
		const code = COMPANION_HID_CODES[key]
		if (code === undefined) {
			throw new Error(`"${key}" can only be sent over the AirPlay connection`)
		}

		const press = async (buttonState: number): Promise<void> => {
			const content: OpackDict = new Map()
			content.set('_hBtS', buttonState)
			content.set('_hidC', code)
			await this.companionRequest('_hidC', content)
		}

		await press(1)
		if (key === 'home_hold') await delay(1000)
		await press(2)
	}

	async sendText(text: string, mode: 'set' | 'insert'): Promise<void> {
		const atv = this.#requireAirplay('The on-screen keyboard')
		if (mode === 'set') await atv.setText(text)
		else await atv.insertText(text)
	}

	async clearText(): Promise<void> {
		await this.#requireAirplay('The on-screen keyboard').clearText()
	}

	async deleteText(): Promise<void> {
		await this.#requireAirplay('The on-screen keyboard').deleteText()
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
		const info: DiscoveredInfo =
			protocol === 'companion'
				? await this.#discover({ ...target, host: target.companionHost, transport: 'companion' })
				: { name: '', address: target.host, port: target.port, deviceId: '', model: '' }

		const atv = new AppleTV(info)
		atv.on('error', () => {
			/* pairing sockets report through the rejected promise instead */
		})

		if (protocol === 'companion') {
			const port = info.companionPort ?? (target.companionPort > 0 ? target.companionPort : undefined)
			if (!port) {
				throw new Error('Could not find the Companion Link port. Set it manually in the module config.')
			}
			const session = await withTimeout(
				atv.startCompanionPairing({ companionPort: port }),
				PAIR_TIMEOUT_MS,
				`request a PIN from ${target.companionHost}`,
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

async function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
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
