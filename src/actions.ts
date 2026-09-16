import type { DropdownChoice } from '@companion-module/base'
import type ModuleInstance from './main.js'
import { Key, errorMessage } from './device.js'
import type { OpackDict, OpackValue } from 'node-appletv-remote'

/** `stop` has no entry in the library's Key enum, so it is handled separately. */
export type RemoteKeyId = `${Key}` | 'stop'

export type TextMode = 'set' | 'insert' | 'clear' | 'delete'

export type ActionsSchema = {
	remote_key: { options: { key: RemoteKeyId } }
	keyboard_text: { options: { mode: TextMode; text: string } }
	launch_app: { options: { bundleId: string } }
	companion_request: { options: { identifier: string; content: string } }
	refresh_state: { options: Record<string, never> }
	reconnect: { options: Record<string, never> }
}

export const REMOTE_KEY_CHOICES: DropdownChoice<RemoteKeyId>[] = [
	{ id: 'up', label: 'Up' },
	{ id: 'down', label: 'Down' },
	{ id: 'left', label: 'Left' },
	{ id: 'right', label: 'Right' },
	{ id: 'select', label: 'Select' },
	{ id: 'menu', label: 'Menu (back)' },
	{ id: 'home', label: 'Home' },
	{ id: 'home_hold', label: 'Home (hold)' },
	{ id: 'top_menu', label: 'Top menu' },
	{ id: 'play', label: 'Play' },
	{ id: 'pause', label: 'Pause' },
	{ id: 'play_pause', label: 'Play / pause' },
	{ id: 'stop', label: 'Stop' },
	{ id: 'next', label: 'Next track' },
	{ id: 'previous', label: 'Previous track' },
	{ id: 'skip_forward', label: 'Skip forward' },
	{ id: 'skip_backward', label: 'Skip backward' },
	{ id: 'volume_up', label: 'Volume up' },
	{ id: 'volume_down', label: 'Volume down' },
	{ id: 'wake', label: 'Turn on (wake)' },
	{ id: 'suspend', label: 'Turn off (sleep)' },
]

export function UpdateActions(self: ModuleInstance): void {
	self.setActionDefinitions({
		remote_key: {
			name: 'Remote key',
			description: 'Send a single button press, as if using the Siri Remote.',
			options: [
				{
					id: 'key',
					type: 'dropdown',
					label: 'Key',
					default: 'select',
					choices: REMOTE_KEY_CHOICES,
				},
			],
			callback: async (action) => {
				const key = action.options.key
				if (key === 'stop') {
					await self.device.stopPlayback()
				} else {
					await self.device.sendKey(key as Key)
				}
				// A key press usually changes what is playing; ask for the new state shortly after.
				self.scheduleStateRefresh()
			},
		},

		keyboard_text: {
			name: 'On-screen keyboard',
			description: 'Type into the text field the Apple TV currently has focused.',
			options: [
				{
					id: 'mode',
					type: 'dropdown',
					label: 'Action',
					default: 'set',
					choices: [
						{ id: 'set', label: 'Replace text' },
						{ id: 'insert', label: 'Append text' },
						{ id: 'clear', label: 'Clear field' },
						{ id: 'delete', label: 'Backspace' },
					],
				},
				{
					id: 'text',
					type: 'textinput',
					label: 'Text',
					default: '',
					useVariables: true,
					isVisibleExpression: `$(options:mode) == 'set' || $(options:mode) == 'insert'`,
				},
			],
			callback: async (action) => {
				const mode = action.options.mode
				switch (mode) {
					case 'clear':
						await self.device.clearText()
						break
					case 'delete':
						await self.device.deleteText()
						break
					default:
						await self.device.sendText(action.options.text ?? '', mode)
						break
				}
			},
		},

		launch_app: {
			name: 'Launch app',
			description: 'Requires a Companion Link connection. Apps are identified by bundle ID.',
			options: [
				{
					id: 'bundleId',
					type: 'textinput',
					label: 'Bundle ID',
					default: 'com.apple.TVWatchList',
					useVariables: true,
					tooltip: 'For example com.netflix.Netflix, com.google.ios.youtube or com.apple.TVMusic',
				},
			],
			callback: async (action) => {
				const bundleId = (action.options.bundleId ?? '').trim()
				if (!bundleId) throw new Error('No bundle ID given')

				await self.device.launchApp(bundleId)
				self.scheduleStateRefresh()
			},
		},

		companion_request: {
			name: 'Companion Link request (advanced)',
			description: 'Send a raw Companion Link message. Intended for experimenting with undocumented commands.',
			options: [
				{
					id: 'identifier',
					type: 'textinput',
					label: 'Identifier',
					default: '_systemInfo',
					useVariables: true,
				},
				{
					id: 'content',
					type: 'textinput',
					label: 'Content (JSON object)',
					default: '{}',
					multiline: true,
					useVariables: true,
				},
			],
			callback: async (action) => {
				const identifier = (action.options.identifier ?? '').trim()
				if (!identifier) throw new Error('No identifier given')

				const content = parseCompanionContent(action.options.content)
				const response = await self.device.companionRequest(identifier, content)
				self.log('debug', `Companion Link response: ${describeOpack(response)}`)
			},
		},

		refresh_state: {
			name: 'Refresh now playing',
			options: [],
			callback: async () => {
				await self.device.refreshState()
			},
		},

		reconnect: {
			name: 'Reconnect',
			description: 'Drop the current connection and connect again.',
			options: [],
			callback: async () => {
				try {
					await self.restartConnection()
				} catch (e) {
					self.log('error', `Reconnect failed: ${errorMessage(e)}`)
				}
			},
		},
	})
}

/** Companion Link payloads are OPACK dictionaries, which map cleanly to a flat JSON object. */
function parseCompanionContent(raw: string | undefined): OpackDict {
	const content: OpackDict = new Map()

	const text = (raw ?? '').trim()
	if (!text || text === '{}') return content

	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch {
		throw new Error(`Content is not valid JSON: ${text}`)
	}

	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new Error('Content must be a JSON object')
	}

	for (const [key, value] of Object.entries(parsed)) {
		content.set(key, value as OpackValue)
	}
	return content
}

function describeOpack(dict: OpackDict): string {
	try {
		return JSON.stringify(Object.fromEntries([...dict].map(([k, v]) => [opackKeyToString(k), v])))
	} catch {
		return '<unserialisable>'
	}
}

function opackKeyToString(key: OpackValue): string {
	switch (typeof key) {
		case 'string':
			return key
		case 'number':
		case 'bigint':
		case 'boolean':
			return key.toString()
		default:
			return '<key>'
	}
}
