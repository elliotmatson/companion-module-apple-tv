import { combineRgb, type CompanionPresetDefinitions, type CompanionPresetSection } from '@companion-module/base'
import type ModuleInstance from './main.js'
import type { ModuleSchema } from './main.js'
import type { RemoteKeyId } from './actions.js'
import { PlaybackState } from './device.js'

const white = combineRgb(255, 255, 255)
const black = combineRgb(0, 0, 0)
const grey = combineRgb(40, 40, 40)
const green = combineRgb(0, 153, 51)
const amber = combineRgb(204, 122, 0)
const red = combineRgb(153, 0, 0)

interface KeyPreset {
	id: string
	key: RemoteKeyId
	text: string
}

const NAVIGATION: KeyPreset[] = [
	{ id: 'up', key: 'up', text: '▲' },
	{ id: 'down', key: 'down', text: '▼' },
	{ id: 'left', key: 'left', text: '◀' },
	{ id: 'right', key: 'right', text: '▶' },
	{ id: 'select', key: 'select', text: 'OK' },
	{ id: 'menu', key: 'menu', text: 'Back' },
	{ id: 'home', key: 'home', text: 'Home' },
	{ id: 'home_hold', key: 'home_hold', text: 'Home\nHold' },
	{ id: 'top_menu', key: 'top_menu', text: 'Top\nMenu' },
]

const PLAYBACK: KeyPreset[] = [
	{ id: 'play', key: 'play', text: 'Play' },
	{ id: 'pause', key: 'pause', text: 'Pause' },
	{ id: 'stop', key: 'stop', text: 'Stop' },
	{ id: 'previous', key: 'previous', text: '|◀◀' },
	{ id: 'next', key: 'next', text: '▶▶|' },
	{ id: 'skip_backward', key: 'skip_backward', text: 'Skip\nBack' },
	{ id: 'skip_forward', key: 'skip_forward', text: 'Skip\nFwd' },
]

const VOLUME: KeyPreset[] = [
	{ id: 'volume_up', key: 'volume_up', text: 'Vol\n+' },
	{ id: 'volume_down', key: 'volume_down', text: 'Vol\n−' },
]

export function UpdatePresets(self: ModuleInstance): void {
	const presets: CompanionPresetDefinitions<ModuleSchema> = {}

	for (const item of [...NAVIGATION, ...PLAYBACK, ...VOLUME]) {
		presets[`key_${item.id}`] = keyPreset(item.text, item.key, grey)
	}

	presets['key_play_pause'] = {
		type: 'simple',
		name: 'Play / pause (shows state)',
		style: { text: '⏯', size: '30', color: white, bgcolor: grey, show_topbar: false },
		steps: [{ down: [{ actionId: 'remote_key', options: { key: 'play_pause' } }], up: [] }],
		feedbacks: [
			{
				feedbackId: 'playback_state',
				options: { state: PlaybackState.Playing },
				style: { bgcolor: green, color: black },
			},
		],
	}

	presets['power_on'] = keyPreset('Turn\nOn', 'wake', green)
	presets['power_off'] = keyPreset('Turn\nOff', 'suspend', red)

	presets['keyboard_backspace'] = {
		type: 'simple',
		name: 'Keyboard: backspace',
		style: { text: '⌫', size: '30', color: white, bgcolor: grey, show_topbar: false },
		steps: [{ down: [{ actionId: 'keyboard_text', options: { mode: 'delete', text: '' } }], up: [] }],
		feedbacks: [],
	}

	presets['keyboard_clear'] = {
		type: 'simple',
		name: 'Keyboard: clear field',
		style: { text: 'Clear\nText', size: '14', color: white, bgcolor: grey, show_topbar: false },
		steps: [{ down: [{ actionId: 'keyboard_text', options: { mode: 'clear', text: '' } }], up: [] }],
		feedbacks: [],
	}

	presets['launch_app'] = {
		type: 'simple',
		name: 'Launch app (set the bundle ID)',
		style: { text: 'Launch\nApp', size: '14', color: white, bgcolor: grey, show_topbar: false },
		steps: [{ down: [{ actionId: 'launch_app', options: { bundleId: 'com.netflix.Netflix' } }], up: [] }],
		feedbacks: [],
	}

	presets['now_playing'] = {
		type: 'simple',
		name: 'Now playing: title and artist',
		style: {
			text: '$(apple-tv:media_title)\n$(apple-tv:media_artist)',
			size: 'auto',
			color: white,
			bgcolor: black,
			show_topbar: false,
		},
		steps: [{ down: [{ actionId: 'refresh_state', options: {} }], up: [] }],
		feedbacks: [
			{
				feedbackId: 'playback_state',
				options: { state: PlaybackState.Playing },
				style: { bgcolor: combineRgb(0, 51, 0) },
			},
		],
	}

	presets['now_playing_time'] = {
		type: 'simple',
		name: 'Now playing: elapsed / duration',
		style: {
			text: '$(apple-tv:media_elapsed_hms)\n$(apple-tv:media_duration_hms)',
			size: '18',
			color: white,
			bgcolor: black,
			show_topbar: false,
		},
		steps: [{ down: [], up: [] }],
		feedbacks: [],
	}

	presets['now_playing_app'] = {
		type: 'simple',
		name: 'Now playing: app',
		style: {
			text: '$(apple-tv:app_name)',
			size: 'auto',
			color: white,
			bgcolor: black,
			show_topbar: false,
		},
		steps: [{ down: [], up: [] }],
		feedbacks: [],
	}

	presets['playback_state'] = {
		type: 'simple',
		name: 'Playback state',
		style: {
			text: '$(apple-tv:playback_state)',
			size: '14',
			color: white,
			bgcolor: black,
			show_topbar: false,
		},
		steps: [{ down: [], up: [] }],
		feedbacks: [
			{ feedbackId: 'playback_state', options: { state: PlaybackState.Playing }, style: { bgcolor: green } },
			{ feedbackId: 'playback_state', options: { state: PlaybackState.Paused }, style: { bgcolor: amber } },
		],
	}

	presets['connection'] = {
		type: 'simple',
		name: 'Connection status (press to reconnect)',
		style: {
			text: '$(apple-tv:device_name)\nOffline',
			size: '14',
			color: white,
			bgcolor: red,
			show_topbar: false,
		},
		steps: [{ down: [{ actionId: 'reconnect', options: {} }], up: [] }],
		feedbacks: [
			{
				feedbackId: 'connected',
				options: {},
				style: { text: '$(apple-tv:device_name)\nOnline', bgcolor: green },
			},
		],
	}

	const structure: CompanionPresetSection<ModuleSchema>[] = [
		{
			id: 'remote',
			name: 'Remote',
			description: 'A button for each key on the Siri Remote.',
			definitions: [
				{
					id: 'navigation',
					type: 'simple',
					name: 'Navigation',
					presets: NAVIGATION.map((item) => `key_${item.id}`),
				},
				{
					id: 'playback',
					type: 'simple',
					name: 'Playback',
					presets: ['key_play_pause', ...PLAYBACK.map((item) => `key_${item.id}`)],
				},
				{
					id: 'volume',
					type: 'simple',
					name: 'Volume',
					presets: VOLUME.map((item) => `key_${item.id}`),
				},
				{
					id: 'power',
					type: 'simple',
					name: 'Power',
					description: 'Wake the Apple TV or put it to sleep.',
					presets: ['power_on', 'power_off'],
				},
				{
					id: 'keyboard',
					type: 'simple',
					name: 'Keyboard',
					description: 'Edit the text field the Apple TV currently has focused.',
					presets: ['keyboard_backspace', 'keyboard_clear'],
				},
			],
		},
		{
			id: 'status',
			name: 'Status',
			description: 'Buttons showing what the Apple TV is doing.',
			definitions: [
				{
					id: 'now_playing',
					type: 'simple',
					name: 'Now playing',
					presets: ['now_playing', 'now_playing_time', 'now_playing_app', 'playback_state'],
				},
				{
					id: 'connection',
					type: 'simple',
					name: 'Connection',
					presets: ['connection'],
				},
			],
		},
		{
			id: 'apps',
			name: 'Apps',
			description: 'Requires a Companion Link connection.',
			definitions: ['launch_app'],
		},
	]

	self.setPresetDefinitions(structure, presets)
}

function keyPreset(
	text: string,
	key: RemoteKeyId,
	bgcolor: number,
): NonNullable<CompanionPresetDefinitions<ModuleSchema>[string]> {
	return {
		type: 'simple',
		name: text.replace(/\n/g, ' ').trim(),
		style: { text, size: text.length > 3 ? '14' : '30', color: white, bgcolor, show_topbar: false },
		steps: [{ down: [{ actionId: 'remote_key', options: { key } }], up: [] }],
		feedbacks: [],
	}
}
