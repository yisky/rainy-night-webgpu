/**
 * @file 演示航线（先做步行）。
 * 路点是地表拾取；相机 Y = 地表 + EYE。
 * 身子沿折线匀速走；头用 workshop DemoTour 的 yaw/pitch 扫视表。
 * 巷子、绕屋各一轮；段起止都是平视，过桥不跳俯仰。
 * 不自动播。
 */

import { Euler, PerspectiveCamera, Vector3 } from 'three'
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { Object3D } from 'three'

/**
 * {@link createSceneTour} 选项。
 */
export interface SceneTourOptions {
	camera: PerspectiveCamera
	controls: OrbitControls
	cityRoot: Object3D
	canalY?: number
	onCue?: ( name: string ) => void
}

/**
 * 演示航线句柄。
 */
export interface SceneTourHandle {
	get playing(): boolean
	update: ( dt: number ) => void
	dispose: () => void
}

/** 开场（用户截取）。 */
const OPEN_POS = [ 45.343, 21.692, 38.276 ] as const
const OPEN_TARGET = [ 1.926, 5.597, -4.203 ] as const

/** 右下角浏览按钮：与雨声按钮同尺寸的相机图标。 */
const CAMERA_SVG =
	'<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M9 4l1.5 2H16l1.5-2H20a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5zm3 13.1A4.1 4.1 0 1 0 12 8.9a4.1 4.1 0 0 0 0 8.2zm0-2.4a1.7 1.7 0 1 1 0-3.4 1.7 1.7 0 0 1 0 3.4z"/></svg>'

/**
 * 地表拾取点。来源：用户 2026-11-04 拾取。
 */
const GROUND: readonly ( readonly [ number, number, number ] )[] = [
	[ 15.183, 6.781, 10.51 ],
	[ 10.084, 6.786, 5.588 ],
	[ 6.121, 6.78, 1.507 ],
	[ 4.417, 6.766, -1.481 ],
	[ 2.686, 6.8, -4.288 ],
	[ 2.058, 6.657, -4.737 ],
	[ 1.441, 6.346, -5.763 ],
	[ 0.701, 6.044, -6.849 ],
	[ -0.464, 5.647, -8.379 ],
	[ -1.448, 5.337, -9.488 ],
	[ -2.616, 5.054, -10.725 ],
	[ -3.793, 4.776, -11.842 ],
	[ -5.08, 4.514, -13.038 ],
	[ -6.232, 4.273, -14.004 ],
	[ -7.738, 3.987, -14.983 ],
	[ -9.235, 3.673, -15.708 ],
	[ -10.783, 3.386, -16.64 ],
	[ -12.243, 3.055, -17.735 ],
	[ -13.485, 2.799, -18.493 ],
	[ -14.934, 2.528, -19.144 ],
	[ -16.643, 2.863, -15.895 ],
	[ -17.399, 3.253, -14.701 ],
	[ -17.66, 3.554, -14.211 ],
	[ -18.143, 3.528, -13.317 ],
	[ -22.094, 3.503, -7.129 ],
	[ -21.072, 3.542, -3.34 ],
	[ -20.565, 3.655, -2.104 ],
	[ -20.183, 3.836, -1.695 ],
	[ -19.393, 3.962, -0.394 ],
	[ -18.488, 3.962, 0.962 ],
	[ -17.81, 4.104, 1.956 ],
	[ -15.696, 4.104, 4.662 ],
]

/** 巷子走到桥（下标 3）为第一段扫视，之后绕屋为第二段。 */
const BRIDGE_INDEX = 3

const EYE = 1.75
const SPEED = 1.45
const GLANCE = 28 * Math.PI / 180
const PITCH_DOWN = -10 * Math.PI / 180
const PITCH_UP = 12 * Math.PI / 180
const LOOKAHEAD = 2.2

type DemoKey = { t: number, x: number, y: number, z: number, yaw: number, pitch: number }
type LookMark = { u: number, yawOff: number, pitch: number }

/** 与 workshop 相同：低头看路 → 左 → 抬头 → 右。 */
const LOOK_LONG: LookMark[] = [
	{ u: 0, yawOff: 0, pitch: 0 },
	{ u: 0.14, yawOff: 0, pitch: PITCH_DOWN },
	{ u: 0.20, yawOff: 0, pitch: PITCH_DOWN },
	{ u: 0.26, yawOff: 0, pitch: 0 },
	{ u: 0.36, yawOff: GLANCE, pitch: PITCH_DOWN * 0.4 },
	{ u: 0.42, yawOff: GLANCE, pitch: PITCH_DOWN * 0.4 },
	{ u: 0.50, yawOff: 0, pitch: 0 },
	{ u: 0.58, yawOff: 0, pitch: PITCH_UP },
	{ u: 0.62, yawOff: 0, pitch: PITCH_UP },
	{ u: 0.66, yawOff: 0, pitch: 0 },
	{ u: 0.76, yawOff: -GLANCE, pitch: PITCH_DOWN * 0.4 },
	{ u: 0.82, yawOff: -GLANCE, pitch: PITCH_DOWN * 0.4 },
	{ u: 0.90, yawOff: 0, pitch: 0 },
	{ u: 1, yawOff: 0, pitch: 0 },
]

function yawFromLook( px: number, pz: number, tx: number, tz: number ): number {
	return Math.atan2( -( tx - px ), -( tz - pz ) )
}

function pitchFromLook( px: number, py: number, pz: number, tx: number, ty: number, tz: number ): number {
	const dx = tx - px
	const dy = ty - py
	const dz = tz - pz
	const len = Math.hypot( dx, dy, dz ) || 1
	return Math.asin( Math.min( 1, Math.max( -1, dy / len ) ) )
}

function unwrapYaw( from: number, to: number ): number {
	let d = to - from
	while ( d > Math.PI ) d -= Math.PI * 2
	while ( d < -Math.PI ) d += Math.PI * 2
	return from + d
}

function distXZ( a: readonly number[], b: readonly number[] ): number {
	return Math.hypot( b[ 0 ] - a[ 0 ], b[ 2 ] - a[ 2 ] )
}

function lerp( a: number, b: number, t: number ): number {
	return a + ( b - a ) * t
}

function smoothstep( t: number ): number {
	const x = Math.min( 1, Math.max( 0, t ) )
	return x * x * ( 3 - 2 * x )
}

function prefixDist(): { dist: number[], total: number, bridge: number } {
	const dist = [ 0 ]
	for ( let i = 1; i < GROUND.length; i++ ) {
		dist.push( dist[ i - 1 ]! + distXZ( GROUND[ i - 1 ]!, GROUND[ i ]! ) )
	}
	return { dist, total: dist[ dist.length - 1 ]!, bridge: dist[ BRIDGE_INDEX ]! }
}

const ARC = prefixDist()

function along( d: number ): { x: number, y: number, z: number } {
	const max = ARC.total
	const s = Math.min( Math.max( d, 0 ), max )
	let i = 0
	while ( i + 1 < ARC.dist.length && ARC.dist[ i + 1 ]! < s ) i++
	const a = GROUND[ i ]!
	const b = GROUND[ Math.min( i + 1, GROUND.length - 1 ) ]!
	const d0 = ARC.dist[ i ]!
	const d1 = ARC.dist[ Math.min( i + 1, ARC.dist.length - 1 ) ]!
	const u = ( d1 - d0 ) > 1e-6 ? ( s - d0 ) / ( d1 - d0 ) : 0
	return {
		x: lerp( a[ 0 ], b[ 0 ], u ),
		y: lerp( a[ 1 ], b[ 1 ], u ) + EYE,
		z: lerp( a[ 2 ], b[ 2 ], u ),
	}
}

function headingAt( d: number ): number {
	const a = along( d )
	const b = along( d + LOOKAHEAD )
	if ( Math.hypot( b.x - a.x, b.z - a.z ) < 1e-4 ) {
		const p = along( Math.max( 0, d - LOOKAHEAD ) )
		return yawFromLook( p.x, p.z, a.x, a.z )
	}
	return yawFromLook( a.x, a.z, b.x, b.z )
}

function glanceAt( u: number ): { yawOff: number, pitch: number } {
	const t = Math.min( 1, Math.max( 0, u ) )
	let i = 0
	while ( i + 1 < LOOK_LONG.length && LOOK_LONG[ i + 1 ]!.u <= t ) i++
	const a = LOOK_LONG[ i ]!
	const b = LOOK_LONG[ Math.min( i + 1, LOOK_LONG.length - 1 ) ]!
	const span = b.u - a.u
	const s = span > 1e-6 ? smoothstep( ( t - a.u ) / span ) : 1
	return {
		yawOff: lerp( a.yawOff, b.yawOff, s ),
		pitch: lerp( a.pitch, b.pitch, s ),
	}
}

function glanceForDist( d: number ): { yawOff: number, pitch: number } {
	if ( d <= ARC.bridge ) {
		return glanceAt( ARC.bridge > 1e-6 ? d / ARC.bridge : 1 )
	}
	const rest = ARC.total - ARC.bridge
	return glanceAt( rest > 1e-6 ? ( d - ARC.bridge ) / rest : 1 )
}

function walkPose( d: number ): DemoKey {
	const p = along( d )
	const g = glanceForDist( d )
	return {
		t: 0,
		x: p.x,
		y: p.y,
		z: p.z,
		yaw: headingAt( d ) + g.yawOff,
		pitch: g.pitch,
	}
}

function sampleKeys( keys: DemoKey[], time: number ): DemoKey {
	const last = keys[ keys.length - 1 ]!
	if ( time >= last.t ) return last
	let i = 0
	while ( i + 1 < keys.length && keys[ i + 1 ]!.t <= time ) i++
	const a = keys[ i ]!
	const b = keys[ i + 1 ]!
	const u = ( time - a.t ) / ( b.t - a.t || 1 )
	const s = smoothstep( u )
	return {
		t: time,
		x: lerp( a.x, b.x, u ),
		y: lerp( a.y, b.y, u ),
		z: lerp( a.z, b.z, u ),
		yaw: lerp( a.yaw, unwrapYaw( a.yaw, b.yaw ), s ),
		pitch: lerp( a.pitch, b.pitch, s ),
	}
}

function buildIntro(): { keys: DemoKey[], walkT0: number, end: number } {
	const p0 = GROUND[ 0 ]!
	const start = walkPose( 0 )
	const keys: DemoKey[] = [
		{
			t: 0,
			x: OPEN_POS[ 0 ],
			y: OPEN_POS[ 1 ],
			z: OPEN_POS[ 2 ],
			yaw: yawFromLook( OPEN_POS[ 0 ], OPEN_POS[ 2 ], OPEN_TARGET[ 0 ], OPEN_TARGET[ 2 ] ),
			pitch: pitchFromLook(
				OPEN_POS[ 0 ], OPEN_POS[ 1 ], OPEN_POS[ 2 ],
				OPEN_TARGET[ 0 ], OPEN_TARGET[ 1 ], OPEN_TARGET[ 2 ],
			),
		},
	]
	keys.push( { ...keys[ 0 ]!, t: 5 } )
	keys.push( {
		t: 11,
		x: p0[ 0 ],
		y: p0[ 1 ] + EYE,
		z: p0[ 2 ],
		yaw: start.yaw,
		pitch: start.pitch,
	} )
	keys.push( { ...keys[ keys.length - 1 ]!, t: 12.2 } )
	const walkT0 = 12.2
	const end = walkT0 + ARC.total / SPEED + 1.6
	return { keys, walkT0, end }
}

/**
 * 「开始浏览」：只播步行段。点击或空格 / Enter。
 */
export function createSceneTour( options: SceneTourOptions ): SceneTourHandle {
	const { camera, controls, onCue } = options
	void onCue
	const intro = buildIntro()
	const euler = new Euler( 0, 0, 0, 'YXZ' )
	const lookDir = new Vector3()

	const button = document.createElement( 'button' )
	button.type = 'button'
	button.className = 'tw-tour tw-glass'
	button.setAttribute( 'aria-label', '开始浏览' )
	button.title = '开始浏览'
	button.innerHTML = CAMERA_SVG
	document.body.append( button )

	let playing = false
	let elapsed = 0

	const apply = ( time: number ) => {
		let pose: DemoKey
		if ( time <= intro.walkT0 ) {
			pose = sampleKeys( intro.keys, time )
		} else {
			const d = Math.min( ( time - intro.walkT0 ) * SPEED, ARC.total )
			pose = walkPose( d )
		}
		camera.position.set( pose.x, pose.y, pose.z )
		euler.set( pose.pitch, pose.yaw, 0, 'YXZ' )
		camera.quaternion.setFromEuler( euler )
	}

	const stop = () => {
		playing = false
		lookDir.set( 0, 0, -1 ).applyQuaternion( camera.quaternion )
		controls.target.copy( camera.position ).addScaledVector( lookDir, 12 )
		controls.enabled = true
		controls.update()
		button.hidden = false
		button.setAttribute( 'aria-label', '再看一遍' )
		button.title = '再看一遍'
		button.innerHTML = CAMERA_SVG
	}

	const start = () => {
		if ( playing ) return
		playing = true
		elapsed = 0
		controls.enabled = false
		button.hidden = true
		apply( 0 )
	}

	const onClick = () => start()
	const onKey = ( event: KeyboardEvent ) => {
		if ( event.repeat || event.ctrlKey || event.metaKey || event.altKey ) return
		if ( event.code !== 'Space' && event.code !== 'Enter' ) return
		const tag = ( event.target as HTMLElement | null )?.tagName
		if ( tag === 'INPUT' || tag === 'TEXTAREA' ) return
		if ( playing ) return
		event.preventDefault()
		start()
	}

	button.addEventListener( 'click', onClick )
	window.addEventListener( 'keydown', onKey )

	return {
		get playing() {
			return playing
		},
		update( dt: number ) {
			if ( ! playing ) return
			elapsed += Math.min( dt, 0.1 )
			if ( elapsed >= intro.end ) {
				apply( intro.end )
				stop()
				return
			}
			apply( elapsed )
		},
		dispose() {
			button.removeEventListener( 'click', onClick )
			window.removeEventListener( 'keydown', onKey )
			button.remove()
		},
	}
}
