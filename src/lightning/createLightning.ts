/**
 * 雨夜闪电：世界空间折线光带 + 青蓝光晕 + 无阴影方向光打湿地。
 *
 * 芯是过曝白、外圈是更粗的加法光晕管。管子不进场景 pass / SceneBloom
 *（Karis 会把细线压没），改由雾后的独立图层相加叠回，再进 `renderOutput`。
 * 整段落在城外天际线圈上，不沿视线反投影，避免穿楼；深度测试只挡眼前的房。
 * 雷声由本模块给出延迟，音频侧一对一播放，不走自发雷。
 *
 * 边界：不改运河 F0 / 倒影增益；不合并河/路反射着色器；不把管子挂第 0 层。
 */

import {
	AdditiveBlending,
	CatmullRomCurve3,
	DirectionalLight,
	DoubleSide,
	FrontSide,
	Group,
	Mesh,
	MeshBasicNodeMaterial,
	TubeGeometry,
	Vector3,
	type Camera,
	type Scene,
} from 'three/webgpu'
import {
	Discard,
	abs,
	color,
	dot,
	Fn,
	mix,
	normalView,
	positionViewDirection,
	pow,
	uniform,
	uv,
} from 'three/tsl'

/** 闪电管图层；主相机需 enable，场景 pass 应 disable，改由雾后 pass 画。 */
export const LIGHTNING_LAYER = 3

/** 城 xz 半径约 24；小于此的点会被推到圆外，避免折线进城。 */
const CITY_CLEAR = 30
/** 天际线圈内半径（世界 xz）。 */
const RING_MIN = 40
/** 天际线圈外半径（世界 xz）。 */
const RING_MAX = 52

/** 主干中点位移迭代次数。5 次约 33 个点。 */
const MAX_ITERS = 5
/** 每层位移幅度相对上一层的衰减。 */
const ROUGHNESS = 0.65
/** 1 为完全直；越小越折。实际位移用 `1 - STRAIGHTNESS`。 */
const STRAIGHTNESS = 0.82
const RADIUS_MAIN = 0.034
const RADIUS_HALO_MAIN = 0.34
const RADIUS_BRANCH = 0.016
const RADIUS_HALO_BRANCH = 0.16
const TUBE_RADIAL_CORE = 5
const TUBE_RADIAL_HALO = 8

/** 一次闪的寿命（秒）。 */
const LIFE = 0.95
/** 沿 UV 生长到全长的时间。 */
const GROW_SEC = 0.07
/** 开始从根部消隐的时刻。 */
const VANISH_START = 0.42

/** 进场景后第一道闪的等待（秒）。 */
const FIRST_DELAY = [ 2, 4 ] as const
/** 上一道结束后到下一道的间隔（秒）。 */
const GAP = [ 7, 12 ] as const
/** 声速，用来估雷声延迟。 */
const SOUND_M_PER_S = 340
const THUNDER_DELAY_MIN = 0.05
const THUNDER_DELAY_MAX = 0.22

/** 无阴影方向光峰值，打湿地和墙。 */
const DIR_PEAK = 3.8
const LIGHT_COLOR = 0xcfe8ff
/** 芯管加法亮度峰值。 */
const BOLT_GLOW = 3.2
/** 光晕管峰值；再乘 env²，尾巴收得比芯快。 */
const HALO_PEAK = 0.42

/**
 * {@link createLightning} 入参。
 */
export interface LightningOptions {
	/** 挂闪电根节点的场景。 */
	scene: Scene
	/** 主相机；会 enable {@link LIGHTNING_LAYER}。 */
	camera: Camera
}

/**
 * 本帧闪电状态，给后处理和音频用。
 */
export interface LightningFrame {
	/** 0～1 包络。雾后整屏微闪、方向光、管子亮度都乘它。 */
	fill: number
	/**
	 * 包络高峰（`env > 0.3`）时为 true。
	 * 调用方只应用来强制河面倒影重烤；路面积水保持错帧，不要两边一起 force。
	 */
	forceBake: boolean
	/** 本闪刚出手的那一帧给出雷声延迟（秒）；其余帧为 null。 */
	thunderDelay: number | null
}

/**
 * 闪电句柄。
 */
export interface LightningHandle {
	/** 管子 + 方向光的根。高度图应把它藏掉。 */
	root: Group
	/**
	 * 用墙钟秒推进。与雨声、灯笼微闪同一时钟。
	 *
	 * @param timeSec - `performance.now() * 0.001`
	 * @param camera - 当前主相机（落点跟水平朝向走）
	 */
	update: ( timeSec: number, camera: Camera ) => LightningFrame
	/**
	 * 立刻打一道（演示抬头段）。若正在闪则打断重来。
	 *
	 * @param camera - 当前主相机，用来选天边落点
	 * @param timeSec - 墙钟秒
	 */
	strikeNow: ( camera: Camera, timeSec: number ) => void
	/** 卸管子几何、材质、方向光，并从场景移除根。 */
	dispose: () => void
}

/** 折线一点：世界坐标 + 沿主干的 0～1 进度（生长/消隐用 UV）。 */
interface RayPoint {
	pos: Vector3
	fraction: number
}

function fract( n: number ): number {
	return n - Math.floor( n )
}

/** 0～1 伪随机；同一 seed 可复现。 */
function hash01( n: number ): number {
	return fract( Math.sin( n * 127.1 ) * 43758.5453 )
}

function randRange( min: number, max: number ): number {
	return min + Math.random() * ( max - min )
}

/** 单位随机方向，写入 `out`。 */
function hashDir( seed: number, out: Vector3 ): Vector3 {
	out.set(
		hash01( seed ) * 2 - 1,
		hash01( seed + 19.19 ) * 2 - 1,
		hash01( seed + 47.3 ) * 2 - 1,
	)
	if ( out.lengthSq() < 1e-8 ) out.set( 0, 1, 0 )
	return out.normalize()
}

/** 关掉默认第 0 层，只留闪电图层，避免进场景 pass / 泛光。 */
function putOnLightningLayer( obj: {
	layers: { disable: ( n: number ) => void, enable: ( n: number ) => void }
} ): void {
	obj.layers.disable( 0 )
	obj.layers.enable( LIGHTNING_LAYER )
}

/**
 * LightningStrike 式中点位移：把 a→b 递归折成锯齿。
 * 每层中点加随机偏移，水平分量钳住以免折进城；落点再夹到天际线圈。
 */
function displaceRay(
	a: Vector3,
	b: Vector3,
	fa: number,
	fb: number,
	depth: number,
	variation: number,
	seed: number,
	out: RayPoint[],
): void {
	if ( depth <= 0 ) {
		out.push( { pos: b.clone(), fraction: fb } )
		return
	}
	const mid = new Vector3().lerpVectors( a, b, 0.5 )
	const len = a.distanceTo( b )
	const offset = hashDir( seed + depth * 13.7 + fa * 91, new Vector3() )
	offset.multiplyScalar( variation * len )
	const maxHoriz = 0.38 * Math.max( len, Math.abs( a.y - b.y ) )
	const horiz = Math.hypot( offset.x, offset.z )
	if ( horiz > maxHoriz && horiz > 1e-6 ) {
		const s = maxHoriz / horiz
		offset.x *= s
		offset.z *= s
	}
	offset.y *= 0.35
	mid.add( offset )
	clampToHorizonRing( mid )
	const fm = ( fa + fb ) * 0.5
	displaceRay( a, mid, fa, fm, depth - 1, variation * ROUGHNESS, seed * 1.17, out )
	displaceRay( mid, b, fm, fb, depth - 1, variation * ROUGHNESS, seed * 1.31, out )
}

/** 从云端到落点生成折线，并保证每个点 xz 都在天际线圈上。 */
function buildPoints( source: Vector3, dest: Vector3, iters: number, seed: number ): Vector3[] {
	const pts: RayPoint[] = [ { pos: source.clone(), fraction: 0 } ]
	displaceRay( source, dest, 0, 1, iters, 1 - STRAIGHTNESS, seed, pts )
	return pts.map( ( p ) => {
		clampToHorizonRing( p.pos )
		return p.pos
	} )
}

/**
 * 从主干一点岔出短枝落点。行程有上限，避免分叉飞到镜头前变成粗柱。
 *
 * @param spread - 侧向随机幅度系数，主干分叉约 1.8，子叉约 1.4。
 */
function forkDest( origin: Vector3, along: Vector3, seed: number, spread: number ): Vector3 | null {
	const len = along.length()
	if ( len < 1e-4 ) return null
	const dir = along.clone().normalize()
	const side = hashDir( seed, new Vector3() )
	side.cross( dir )
	if ( side.lengthSq() < 1e-8 ) return null
	side.normalize()
	const dest = origin.clone()
		.add( dir.multiplyScalar( Math.min( 7, len * ( 1.15 + hash01( seed + 1 ) * spread ) ) ) )
		.add( side.multiplyScalar( ( hash01( seed + 2 ) - 0.5 ) * Math.min( 5, len * spread ) ) )
	dest.y += ( hash01( seed + 5 ) - 0.42 ) * len * 1.1
	clampToHorizonRing( dest )
	return dest
}

/**
 * 沿主干抽最多 8 条分叉，部分再出一截子叉。
 * 分叉几何仍走 {@link buildPoints}，xz 同样夹在天际线圈上。
 */
function tryBranches( main: Vector3[], seed: number ): Vector3[][] {
	const branches: Vector3[][] = []
	const n = main.length
	const i0 = Math.max( 2, Math.floor( n * 0.08 ) )
	const i1 = Math.min( n - 3, Math.floor( n * 0.84 ) )
	for ( let i = i0; i < i1; i += 2 ) {
		if ( branches.length >= 8 ) break
		if ( hash01( seed + i * 9.1 ) > 0.74 ) continue
		const p = main[ i ]!
		const prev = main[ i - 1 ]!
		const dest = forkDest( p, new Vector3().subVectors( p, prev ), seed + i * 17, 1.8 )
		if ( ! dest ) continue
		const branch = buildPoints( p, dest, 2, seed + i * 17 )
		branches.push( branch )
		if ( branches.length >= 8 || branch.length < 5 ) continue
		if ( hash01( seed + i + 3.3 ) < 0.48 ) continue
		const mid = branch[ Math.floor( branch.length * ( 0.3 + hash01( seed + i + 4 ) * 0.35 ) ) ]!
		const childDest = forkDest( mid, new Vector3().subVectors( dest, p ), seed + i * 29, 1.4 )
		if ( ! childDest ) continue
		branches.push( buildPoints( mid, childDest, 2, seed + i * 31 ) )
	}
	return branches
}

/**
 * 三次短脉冲 + 指数尾巴，峰值钳在 1。
 * 方向光、芯管跟它走；光晕再平方，灭得更快。
 */
function lightEnvelope( elapsed: number ): number {
	if ( elapsed < 0 || elapsed >= LIFE ) return 0
	const p1 = Math.exp( -( ( ( elapsed - 0.05 ) / 0.02 ) ** 2 ) )
	const p2 = 0.55 * Math.exp( -( ( ( elapsed - 0.18 ) / 0.024 ) ** 2 ) )
	const p3 = 0.32 * Math.exp( -( ( ( elapsed - 0.34 ) / 0.028 ) ** 2 ) )
	const body = 0.34 * Math.exp( -elapsed / 0.22 )
	return Math.min( 1, p1 + p2 + p3 + body )
}

/** 相机水平朝向（去掉 Y），用来选天际线圈上的方位角。 */
function flattenedForward( camera: Camera, out: Vector3 ): Vector3 {
	camera.getWorldDirection( out )
	out.y = 0
	if ( out.lengthSq() < 1e-6 ) out.set( 0, 0, -1 )
	return out.normalize()
}

/**
 * 把点的 xz 夹在 `[CITY_CLEAR, RING_MAX+4]`。
 * 进城会穿楼；飞出环会落到镜头附近，管看起来极粗。
 */
function clampToHorizonRing( p: Vector3 ): void {
	const r = Math.hypot( p.x, p.z )
	const maxR = RING_MAX + 4
	if ( r < 1e-6 ) {
		p.x = CITY_CLEAR
		return
	}
	if ( r < CITY_CLEAR ) {
		const s = CITY_CLEAR / r
		p.x *= s
		p.z *= s
		return
	}
	if ( r > maxR ) {
		const s = maxR / r
		p.x *= s
		p.z *= s
	}
}

/** 世界原点水平圆上的一点。`azimuth` 为从 +Z 起、朝 +X 的角。 */
function ringPoint( azimuth: number, radius: number, y: number ): Vector3 {
	return new Vector3( Math.sin( azimuth ) * radius, y, Math.cos( azimuth ) * radius )
}

/** 把角折回 (−π, π]。 */
function wrapPi( a: number ): number {
	return Math.atan2( Math.sin( a ), Math.cos( a ) )
}

/**
 * 云端大致落在屏幕里才算「这轮看得见」。
 * 贴墙时天边可能全在视锥外，调用方仍会用 fallback 出手（被墙挡住是预期）。
 */
function fitsScreen( camera: Camera, source: Vector3, dest: Vector3 ): boolean {
	const s = source.clone().project( camera )
	const d = dest.clone().project( camera )
	if ( s.z < -1 || s.z > 1 ) return false
	if ( s.y < -0.05 ) return false
	if ( d.z < -1 || d.z > 1 ) return false
	return true
}

/** 按落点距离 / 声速估延迟，钳在 0.05～0.22 秒，听起来仍跟闪对齐。 */
function thunderDelayFor( camera: Camera, dest: Vector3 ): number {
	const dist = camera.position.distanceTo( dest )
	return Math.min( THUNDER_DELAY_MAX, Math.max( THUNDER_DELAY_MIN, dist / SOUND_M_PER_S ) )
}

/**
 * 在城外天际线圈上取云端和落点。
 *
 * 方位 = 相机水平朝向 ±40°（正前方那一块天，外景时是城背后的天边）。
 * 半径 40～52；云端 y 约 26～38，落地 y 约 12～18，约 20% 为云间闪。
 * 相邻两次方位差太小会再偏一截，避免总在同一块天。
 */
function placeBolt(
	camera: Camera,
	seed: number,
	avoidAz: number | null,
): { source: Vector3, dest: Vector3, azimuth: number } {
	const fwd = flattenedForward( camera, new Vector3() )
	let az = Math.atan2( fwd.x, fwd.z )
	az += ( hash01( seed ) - 0.5 ) * ( 80 * Math.PI / 180 )
	if ( avoidAz !== null && Math.abs( wrapPi( az - avoidAz ) ) < 0.45 ) {
		az += wrapPi( az - avoidAz ) >= 0 ? 0.9 : -0.9
	}
	az = wrapPi( az )
	const r0 = RING_MIN + hash01( seed + 1 ) * ( RING_MAX - RING_MIN )
	const r1 = Math.max( CITY_CLEAR + 2, r0 + ( hash01( seed + 2 ) - 0.25 ) * 6 )
	const y0 = 26 + hash01( seed + 3 ) * 12
	const sideSign = hash01( seed + 4 ) > 0.5 ? 1 : -1
	const cloudToCloud = hash01( seed + 5 ) > 0.8
	const source = ringPoint( az, r0, y0 )
	let dest: Vector3
	if ( cloudToCloud ) {
		const dAz = sideSign * ( 0.18 + hash01( seed + 6 ) * 0.22 )
		dest = ringPoint( wrapPi( az + dAz ), r1, 18 + hash01( seed + 7 ) * 10 )
	} else {
		const dAz = sideSign * ( 0.08 + hash01( seed + 6 ) * 0.2 )
		dest = ringPoint( wrapPi( az + dAz ), r1, 12 + hash01( seed + 7 ) * 6 )
	}
	clampToHorizonRing( source )
	clampToHorizonRing( dest )
	return { source, dest, azimuth: az }
}

/**
 * 试最多 8 个落点，优先 {@link fitsScreen} 成功的；
 * 全看不见也返回最后一个，不把闪硬塞进墙里的视线。
 */
function pickStrike(
	camera: Camera,
	baseSeed: number,
	avoidAz: number | null,
): { source: Vector3, dest: Vector3, azimuth: number } {
	camera.updateMatrixWorld()
	let fallback = placeBolt( camera, baseSeed, avoidAz )
	for ( let k = 0; k < 8; k++ ) {
		const pair = placeBolt( camera, baseSeed + k * 19, avoidAz )
		if ( fitsScreen( camera, pair.source, pair.dest ) ) return pair
		fallback = pair
	}
	return fallback
}

/**
 * 加法管子材质：不写深度、测深度、不进材质雾、toneMapped 关掉
 *（管子先线性叠进雾后 pass，整屏再走 `renderOutput`）。
 */
function setupBoltMaterial(
	name: string,
	colorNode: MeshBasicNodeMaterial['colorNode'],
	side: typeof DoubleSide | typeof FrontSide,
): MeshBasicNodeMaterial {
	const material = new MeshBasicNodeMaterial()
	material.name = name
	material.colorNode = colorNode
	material.toneMapped = false
	material.fog = false
	material.depthWrite = false
	material.depthTest = true
	material.transparent = true
	material.side = side
	material.blending = AdditiveBlending
	return material
}

/** Catmull 管。点数太少返回 null。径向段数芯少晕多。 */
function makeTube(
	points: Vector3[],
	radius: number,
	radial: number,
	material: MeshBasicNodeMaterial,
	renderOrder: number,
): Mesh | null {
	if ( points.length < 2 ) return null
	const curve = new CatmullRomCurve3( points )
	const geo = new TubeGeometry( curve, Math.max( 24, points.length * 2 ), radius, radial, false )
	const mesh = new Mesh( geo, material )
	mesh.castShadow = false
	mesh.receiveShadow = false
	mesh.renderOrder = renderOrder
	putOnLightningLayer( mesh )
	return mesh
}

/**
 * 搭建闪电：白芯 + 青蓝光晕管 + 无阴影方向光。
 *
 * 调用方须：主相机 enable 本图层；场景 pass disable 本图层；雾后单独 pass 画管子；
 * `thunderDelay !== null` 时播雷；`forceBake` 时只强制河面烤图。
 *
 * @param options - 场景与相机。
 */
export function createLightning( options: LightningOptions ): LightningHandle {
	const { scene, camera } = options
	camera.layers.enable( LIGHTNING_LAYER )

	const root = new Group()
	root.name = 'Lightning'

	const uGlow = uniform( 0 )
	const uHalo = uniform( 0 )
	/** 沿管 UV.x 生长到此为止；小于此的片段 Discard。 */
	const uGrow = uniform( 1 )
	/** 沿管 UV.x 从此处消隐。 */
	const uVanish = uniform( 0 )

	const coreMaterial = setupBoltMaterial( 'LightningCore', Fn( () => {
		const along = uv().x
		Discard( along.greaterThan( uGrow ).or( along.lessThan( uVanish ) ) )
		const ndv = abs( dot( normalView, positionViewDirection ) )
		const rim = pow( ndv, 3.5 )
		return mix( color( 0xa8c8ff ), color( 0xf5fbff ), rim ).mul( uGlow )
	} )(), DoubleSide )

	const haloMaterial = setupBoltMaterial( 'LightningHalo', Fn( () => {
		const along = uv().x
		Discard( along.greaterThan( uGrow ).or( along.lessThan( uVanish ) ) )
		const ndv = abs( dot( normalView, positionViewDirection ) )
		const fall = pow( ndv, 2.2 )
		return color( 0x9fc8ff ).mul( uHalo ).mul( fall )
	} )(), FrontSide )

	const bolts = new Group()
	bolts.name = 'LightningBolts'
	putOnLightningLayer( bolts )
	root.add( bolts )

	const dirLight = new DirectionalLight( LIGHT_COLOR, 0 )
	dirLight.name = 'LightningFill'
	dirLight.castShadow = false
	root.add( dirLight )
	root.add( dirLight.target )
	scene.add( root )

	let striking = false
	let strikeStart = 0
	let nextStrikeAt = randRange( FIRST_DELAY[ 0 ], FIRST_DELAY[ 1 ] )
	let strikeSeed = 1
	let thunderSent = false
	let pendingThunderDelay = 0
	let lastAz: number | null = null
	let lastTime = 0

	const clearBolts = () => {
		while ( bolts.children.length > 0 ) {
			const child = bolts.children[ 0 ] as Mesh
			child.geometry.dispose()
			bolts.remove( child )
		}
	}

	const addBolt = ( points: Vector3[], coreR: number, haloR: number ) => {
		const halo = makeTube( points, haloR, TUBE_RADIAL_HALO, haloMaterial, 12 )
		const core = makeTube( points, coreR, TUBE_RADIAL_CORE, coreMaterial, 13 )
		if ( halo ) bolts.add( halo )
		if ( core ) bolts.add( core )
	}

	/** 选落点、重建管子、对准方向光、记下雷声延迟。 */
	const beginStrike = ( view: Camera, timeSec: number ) => {
		strikeSeed += 1
		const pair = pickStrike( view, strikeSeed, lastAz )
		clearBolts()
		const dist = view.position.distanceTo( pair.dest )
		const scale = Math.min( 1.6, Math.max( 1, dist / 40 ) )
		const main = buildPoints( pair.source, pair.dest, MAX_ITERS, strikeSeed )
		addBolt( main, RADIUS_MAIN * scale, RADIUS_HALO_MAIN * scale )
		for ( const branch of tryBranches( main, strikeSeed + 99 ) ) {
			addBolt( branch, RADIUS_BRANCH * scale, RADIUS_HALO_BRANCH * scale )
		}
		dirLight.position.copy( pair.source )
		dirLight.target.position.copy( pair.dest )
		dirLight.target.updateMatrixWorld()
		striking = true
		strikeStart = timeSec - 0.02
		thunderSent = false
		pendingThunderDelay = thunderDelayFor( view, pair.dest )
		lastAz = pair.azimuth
		bolts.visible = true
	}

	const idle = (): LightningFrame => ( {
		fill: 0,
		forceBake: false,
		thunderDelay: null,
	} )

	return {
		root,
		strikeNow: ( view: Camera, timeSec: number ) => {
			if ( striking ) {
				clearBolts()
				striking = false
			}
			lastTime = timeSec
			beginStrike( view, timeSec )
		},
		update: ( timeSec: number, view: Camera ) => {
			// 首帧用墙钟对齐，避免模块构造到第一帧之间的空档把 FIRST_DELAY 吃掉。
			if ( lastTime === 0 ) {
				nextStrikeAt = timeSec + randRange( FIRST_DELAY[ 0 ], FIRST_DELAY[ 1 ] )
			}
			lastTime = timeSec

			if ( ! striking ) {
				bolts.visible = false
				dirLight.intensity = 0
				uGlow.value = 0
				uHalo.value = 0
				if ( timeSec >= nextStrikeAt ) beginStrike( view, timeSec )
				if ( ! striking ) return idle()
			}

			const elapsed = timeSec - strikeStart
			if ( elapsed >= LIFE ) {
				striking = false
				clearBolts()
				bolts.visible = false
				dirLight.intensity = 0
				uGlow.value = 0
				uHalo.value = 0
				nextStrikeAt = timeSec + randRange( GAP[ 0 ], GAP[ 1 ] )
				return idle()
			}

			uGrow.value = Math.min( 1, elapsed / GROW_SEC )
			uVanish.value = elapsed < VANISH_START ? 0 : ( elapsed - VANISH_START ) / ( LIFE - VANISH_START )
			const env = lightEnvelope( elapsed )
			dirLight.intensity = DIR_PEAK * env
			uGlow.value = BOLT_GLOW * env
			uHalo.value = HALO_PEAK * env * env
			const thunderDelay = thunderSent ? null : pendingThunderDelay
			if ( thunderDelay !== null ) thunderSent = true
			return {
				fill: env,
				forceBake: env > 0.3,
				thunderDelay,
			}
		},
		dispose: () => {
			clearBolts()
			root.removeFromParent()
			coreMaterial.dispose()
			haloMaterial.dispose()
			dirLight.dispose()
		},
	}
}
