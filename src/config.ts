import { Regex, type SomeCompanionConfigField } from '@companion-module/base'
import type { Transport } from './device.js'

export type ModuleConfig = {
	/** `10.0.0.1:7000` when a bonjour device is picked, otherwise null/'' */
	bonjour_host: string | null
	host: string
	port: number

	/** Fallback only. 0 = always discover the companion-link port over mDNS */
	companionPort: number

	transport: Transport

	pairStart: boolean
	pairPin: string

	pollInterval: number
	reconnectInterval: number
}

export type ModuleSecrets = {
	/** Serialised `Credentials` JSON from node-appletv-remote */
	credentials: string
}

/** What the config page should say about the credentials already stored. */
export interface PairingStatus {
	airplay: boolean
	companion: boolean
}

export function GetConfigFields(paired: PairingStatus): SomeCompanionConfigField[] {
	const tick = (ok: boolean) => (ok ? '✅ paired' : '❌ not paired')

	return [
		{
			type: 'static-text',
			id: 'info',
			label: 'Apple TV',
			width: 12,
			value:
				'Controls an Apple TV over the local network. Pick your Apple TV below (or enter its IP), then tick ' +
				'<b>Begin pairing</b> and save. The Apple TV shows a PIN — type it into <b>Pairing PIN</b> and save ' +
				'again. It then shows a <b>second</b> PIN for the other protocol; enter that one the same way. ' +
				'Pairing only has to be done once.',
		},

		{
			type: 'bonjour-device',
			id: 'bonjour_host',
			label: 'Apple TV (AirPlay)',
			width: 6,
			description: 'Discovered over Bonjour. Choose "Manual" to type an address instead.',
			disableAutoExpression: true,
		},
		{
			type: 'textinput',
			id: 'host',
			label: 'Target IP',
			width: 4,
			default: '',
			regex: Regex.IP,
			isVisibleExpression: `!$(options:bonjour_host)`,
			disableAutoExpression: true,
		},
		{
			type: 'number',
			id: 'port',
			label: 'AirPlay port',
			width: 2,
			default: 7000,
			min: 1,
			max: 65535,
			isVisibleExpression: `!$(options:bonjour_host)`,
			disableAutoExpression: true,
		},

		{
			type: 'dropdown',
			id: 'transport',
			label: 'Use',
			width: 12,
			default: 'both',
			choices: [
				{ id: 'both', label: 'Both — AirPlay for control, Companion Link for launching apps' },
				{ id: 'airplay', label: 'AirPlay only — remote keys, keyboard and now playing' },
				{ id: 'companion', label: 'Companion Link only — app launching and basic remote keys' },
			],
			description:
				'With "Both", each connection is made, retried and reported on its own, so losing one does not ' +
				'disturb the other. Companion Link is skipped until you pair it.',
			disableAutoExpression: true,
		},

		{
			type: 'static-text',
			id: 'pair_info',
			label: 'Pairing',
			width: 12,
			value:
				`AirPlay: <b>${tick(paired.airplay)}</b> &nbsp;&nbsp;|&nbsp;&nbsp; Companion Link: <b>${tick(paired.companion)}</b><br>` +
				'Pairing covers both protocols in one run, which is why the Apple TV shows two PINs — AirPlay first, ' +
				'then Companion Link. The Apple TV must be awake and on the same network. If the second pairing ' +
				'cannot be started, the first is still kept and the connection carries on without Companion Link.',
		},
		{
			type: 'checkbox',
			id: 'pairStart',
			label: 'Begin pairing',
			width: 6,
			default: false,
			description: 'Tick and save. The Apple TV shows the first PIN.',
			disableAutoExpression: true,
		},
		{
			type: 'textinput',
			id: 'pairPin',
			label: 'Pairing PIN',
			width: 6,
			default: '',
			description: 'Enter each PIN shown on the TV, saving after each one. There are two.',
			disableAutoExpression: true,
		},
		{
			type: 'secret-text',
			id: 'credentials',
			label: 'Credentials',
			width: 12,
			description:
				'Filled in automatically once pairing succeeds, and holds both protocols. You can also paste ' +
				'credentials produced by the node-appletv-remote CLI (`atv pair`) here. Clearing this field unpairs ' +
				'the connection.',
		},

		{
			type: 'static-text',
			id: 'advanced_info',
			label: 'Advanced',
			width: 12,
			value: '',
		},
		{
			type: 'number',
			id: 'companionPort',
			label: 'Companion Link port',
			width: 3,
			default: 0,
			min: 0,
			max: 65535,
			description:
				'Leave at 0. The port is discovered over Bonjour, and the Apple TV picks a new one every time it ' +
				'restarts — only set this if Bonjour is blocked on your network, and expect to update it.',
			isVisibleExpression: `$(options:transport) != 'airplay'`,
			disableAutoExpression: true,
		},
		{
			type: 'number',
			id: 'pollInterval',
			label: 'Now playing refresh (seconds)',
			width: 3,
			default: 15,
			min: 0,
			max: 600,
			description: 'Backstop for the push updates. 0 disables it.',
			disableAutoExpression: true,
		},
		{
			type: 'number',
			id: 'reconnectInterval',
			label: 'Reconnect delay (seconds)',
			width: 3,
			default: 10,
			min: 2,
			max: 600,
			disableAutoExpression: true,
		},
	]
}

/** Resolve the address to connect to, honouring the bonjour picker over the manual fields. */
export function resolveTarget(config: ModuleConfig): { host: string; port: number } | null {
	const discovered = splitHostPort(config.bonjour_host)
	if (discovered) return discovered

	const host = (config.host ?? '').trim()
	if (!host) return null

	const port = config.port && config.port > 0 ? config.port : 7000
	return { host, port }
}

function splitHostPort(value: string | null | undefined): { host: string; port: number } | null {
	if (!value) return null

	const idx = value.lastIndexOf(':')
	if (idx <= 0) return null

	const host = value.slice(0, idx)
	const port = Number(value.slice(idx + 1))
	if (!host || !Number.isFinite(port) || port <= 0) return null

	return { host, port }
}
