import { Regex, type SomeCompanionConfigField } from '@companion-module/base'

/** Which transport the pairing flow should pair with. */
export type PairProtocol = 'airplay' | 'companion'

export type ModuleConfig = {
	/** `10.0.0.1:7000` when a bonjour device is picked, otherwise null/'' */
	bonjour_host: string | null
	host: string
	port: number
	/** 0 = discover the companion-link port over mDNS */
	companionPort: number
	/** Open the secondary Companion Link connection alongside the AirPlay one */
	useCompanion: boolean

	pairProtocol: PairProtocol
	pairStart: boolean
	pairPin: string

	pollInterval: number
	reconnectInterval: number
}

export type ModuleSecrets = {
	/** Serialised `Credentials` JSON from node-appletv-remote */
	credentials: string
}

export function GetConfigFields(): SomeCompanionConfigField[] {
	return [
		{
			type: 'static-text',
			id: 'info',
			label: 'Apple TV',
			width: 12,
			value:
				'Controls an Apple TV over the local network. Pick your Apple TV below (or enter its IP), then run the ' +
				'pairing flow: tick <b>Begin pairing</b> and save — a PIN appears on the TV. Type that PIN into ' +
				'<b>Pairing PIN</b> and save again. Credentials are stored for you and pairing only has to be done once.',
		},

		{
			type: 'bonjour-device',
			id: 'bonjour_host',
			label: 'Apple TV',
			width: 6,
			description: 'Discovered over Bonjour. Choose "Manual" to type an address instead.',
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
			type: 'static-text',
			id: 'pair_info',
			label: 'Pairing',
			width: 12,
			value:
				'Pairing talks to the Apple TV directly, so it must be awake and on the same network. ' +
				'Use <b>AirPlay</b> unless you specifically need Companion Link features.',
		},
		{
			type: 'dropdown',
			id: 'pairProtocol',
			label: 'Pair with',
			width: 4,
			default: 'airplay',
			choices: [
				{ id: 'airplay', label: 'AirPlay (remote control, now playing)' },
				{ id: 'companion', label: 'Companion Link (app launching)' },
			],
			disableAutoExpression: true,
		},
		{
			type: 'checkbox',
			id: 'pairStart',
			label: 'Begin pairing',
			width: 4,
			default: false,
			description: 'Tick and save. A PIN will appear on the Apple TV.',
			disableAutoExpression: true,
		},
		{
			type: 'textinput',
			id: 'pairPin',
			label: 'Pairing PIN',
			width: 4,
			default: '',
			description: 'Enter the PIN shown on the TV, then save.',
			disableAutoExpression: true,
		},
		{
			type: 'secret-text',
			id: 'credentials',
			label: 'Credentials',
			width: 12,
			description:
				'Filled in automatically once pairing succeeds. You can also paste credentials produced by the ' +
				'node-appletv-remote CLI (`atv pair`) here. Clearing this field unpairs the connection.',
		},

		{
			type: 'static-text',
			id: 'advanced_info',
			label: 'Advanced',
			width: 12,
			value: '',
		},
		{
			type: 'checkbox',
			id: 'useCompanion',
			label: 'Enable Companion Link',
			width: 4,
			default: false,
			description: 'Opens a second connection used for launching apps. Requires Companion Link credentials.',
			disableAutoExpression: true,
		},
		{
			type: 'number',
			id: 'companionPort',
			label: 'Companion Link port',
			width: 4,
			default: 0,
			min: 0,
			max: 65535,
			description: '0 discovers the port over Bonjour.',
			isVisibleExpression: `!!$(options:useCompanion)`,
			disableAutoExpression: true,
		},
		{
			type: 'number',
			id: 'pollInterval',
			label: 'Now playing refresh (seconds)',
			width: 4,
			default: 10,
			min: 0,
			max: 600,
			description: 'Periodic state request as a backstop to the push updates. 0 disables it.',
			disableAutoExpression: true,
		},
		{
			type: 'number',
			id: 'reconnectInterval',
			label: 'Reconnect delay (seconds)',
			width: 4,
			default: 10,
			min: 2,
			max: 600,
			disableAutoExpression: true,
		},
	]
}

/** Resolve the address to connect to, honouring the bonjour picker over the manual fields. */
export function resolveTarget(config: ModuleConfig): { host: string; port: number } | null {
	if (config.bonjour_host) {
		const idx = config.bonjour_host.lastIndexOf(':')
		if (idx > 0) {
			const host = config.bonjour_host.slice(0, idx)
			const port = Number(config.bonjour_host.slice(idx + 1))
			if (host && Number.isFinite(port) && port > 0) return { host, port }
		}
	}

	const host = (config.host ?? '').trim()
	if (!host) return null
	const port = config.port && config.port > 0 ? config.port : 7000
	return { host, port }
}
