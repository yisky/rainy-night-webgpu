/**
 * 路 / 桥 / 石阶积水湿膜与局部平面倒影叠层。
 *
 * 按名字识别 asphalt / pavement / sidewalk / parkRoad / bridge / stair 等网格，
 * 另白名单 SM_canalBorder00/01/03/04/05。克隆一份叠在原网格上，共用湿贴图 + 程序涟漪。
 * 倒影走局部平面烤图 + ReflectOverlay：平路按高度分 2 组各一面镜子；
 * 台阶/跨层坡路只留湿膜光带。水洼与湿膜两套高度容差。
 * 湿膜倒影用 mip lod + 短密 9-tap + IGN 抖动。
 * 高度图 / 世界噪声只在叠层采样，不进 Shared 标准湿膜（本机 samplers 硬顶 16）。
 */

import {
	AdditiveBlending,
	Mesh,
	MeshBasicNodeMaterial,
	MeshStandardNodeMaterial,
	RepeatWrapping,
	SRGBColorSpace,
	TextureLoader,
	type Mesh as MeshType,
	type Object3D,
	type Scene,
	type Texture,
} from 'three/webgpu'
import {
	cameraPosition,
	dot,
	float,
	interleavedGradientNoise,
	mix,
	mx_noise_float,
	normalMap,
	normalWorldGeometry,
	normalize,
	positionWorld,
	saturate,
	select,
	smoothstep,
	texture,
	uniform,
	uv,
	vec2,
	vec3,
	vec4,
	viewportCoordinate,
} from 'three/tsl'

import { createRippleFn } from './createRipples'
import {
	PUDDLE_MASK_DEFAULTS,
	createPuddleMaskNode,
	puddleRippleGate,
} from './createPuddleMask'
import { HEIGHT_MAP_DEFAULTS, type HeightMapHandle } from '../rain/createHeightMap'

/**
 * 名字命中则视为路面 / 桥面 / 石阶（大小写不敏感）。
 * stair 含 SM_stair* / SM_Stairs / sm_shrineStairs 等。
 */
const ROAD_BRIDGE_NAME =
	/(asphalt|pavement|sidewalk|sideWalk|parkRoad|path_bridge|bridge|dirtGround|stair)/i

/**
 * 排除：河道边墙、草地、景石 rock（慎扩；默认不打湿装饰石）。
 */
const EXCLUDE_NAME =
	/(canalBorder|canalWall|canalDetail|grass|hedge|bamboo|rock)/i


/**
 * 湿膜名称白名单：放行 SM_canalBorder00/01/03/04/05（00/04 为 Material_8946；01/03/05 为 Material_8916）。
 * 不扩到其它 canalBorder*；叠膜参数仍用 RoadBridgeWetShared 当前默认，不加发亮色环。
 */
const WET_NAME_WHITELIST = /^SM_canalBorder(?:00|01|03|04|05)(?:$|_)/i

/**
 * 路桥湿膜与倒影叠层默认值。倒影强度在 App 里传给烤炉，不在此表。
 */
export const ROAD_BRIDGE_WET_DEFAULTS = {
	uvRepeat: 10,
	/** 略更滑，夜灯高光更明显。 */
	roughnessScale: 0.28,
	/** 世界 xz 乘此值进涟漪 Fn；越大环越密/越小。旧默认 3.2，现 5.0 明显收小环径。 */
	rippleScale: 25.0,
	rippleSpeed: 3,
	rippleAmount: 1,
	/** 涟漪推 UV，让湿贴图本身跟着环纹晃（此前未接线）。 */
	rippleStrength: 0.28,
	/** 涟漪看法线，环纹起伏更显眼。 */
	rippleNormalStrength: 0.18,
	albedoBoost: 3.6,
	opacity: 0.96,
	albedoUrl: '/textures/wet-puddles-albedo.jpg',
	roughnessUrl: '/textures/wet-puddles-roughness.jpg',
	normalUrl: '/textures/wet-puddles-normal.jpg',
	/** 法线凹度差分步长（见 PUDDLE_MASK_DEFAULTS）。 */
	concavityEps: PUDDLE_MASK_DEFAULTS.concavityEps,
	/** 凹度增益。 */
	concavityGain: PUDDLE_MASK_DEFAULTS.concavityGain,
	/** 粗糙度暗区辅助权重。 */
	roughnessAssist: PUDDLE_MASK_DEFAULTS.roughnessAssist,
	/** 极弱噪声调制（不主导塘位）。 */
	noiseMod: PUDDLE_MASK_DEFAULTS.noiseMod,
	/** 噪声调制世界 xz 频率（仅 noiseMod>0）。 */
	puddleScale: PUDDLE_MASK_DEFAULTS.puddleScale,
	/** 噪声阈值，越高塘越稀。 */
	puddleThreshold: PUDDLE_MASK_DEFAULTS.puddleThreshold,
	/** 塘缘 softstep 宽度。 */
	puddleSoftness: PUDDLE_MASK_DEFAULTS.puddleSoftness,
	/** 非积水区涟漪残留（与 puddleOutsideRipple 同源；默认 0，仅塘内有环）。 */
	puddleOutsideRipple: PUDDLE_MASK_DEFAULTS.puddleOutsideRipple,
	/**
	 * 塘内目标粗糙度（越低镜面越清晰）。与 roughnessSample×roughnessScale 按 mask 混合。
	 */
	puddleRoughness: 0.08,
	/**
	 * 侧面关断：世界法线 Y 的 smoothstep 下沿。
	 * 只保留近似水平面；石柱/桥帮立面法线近水平 → 门控为 0。
	 */
	sideUpMin: 0.55,
	/** 侧面关断 smoothstep 上沿；≥ 此值视为充分朝上。 */
	sideUpMax: 0.85,
	/**
	 * 倒影中心点横向轻糊半径（RT UV，9-tap 中心三点）。
	 * 湿膜分支另用 uFilmBlur。
	 */
	reflectBlurMax: 0.0012,
	/** Schlick 菲涅尔 F0（与河面同为 0.08）。 */
	fresnelF0: 0.08,
	/** 水洼竖向拉伸长度（RT 的 v 方向）。 */
	puddleStreak: 0.006,
	/**
	 * 湿膜倒影相对水洼的比例。
	 * strength 提到 2.5 后压到 0.13，避免湿膜光带过亮。
	 */
	filmReflect: 0.13,
	/**
	 * 湿膜竖向拉伸总长度（RT 的 v 方向）。
	 * 9-tap 间距 = filmStreak/6。水洼仍用 puddleStreak 作单步间距。
	 */
	filmStreak: 0.01,
	/** 湿膜水平模糊半径。mip lod 已够糊，默认 0。 */
	filmBlur: 0,
	/** 湿膜倒影采样 mip lod（水洼固定 level 0）。 */
	filmLod: 1.0,
	/** 水洼涟漪扰动。 */
	reflectNormalWarp: 0.04,
	/** 扰动的距离衰减参考深度（米）。 */
	warpRefDepth: 8,
	/** 水洼分支：与镜面高度差的淡出近距（米）。 */
	planeFadeNear: 0.30,
	/** 水洼分支：与镜面高度差的淡出远距（米）。 */
	planeFadeFar: 0.80,
	/** 湿膜分支：高度差淡出近距（米）。光带本来就糊，容差更宽。 */
	filmFadeNear: 2.0,
	/** 湿膜分支：高度差淡出远距（米）。 */
	filmFadeFar: 3.0,
	/** 世界噪声频率（约 3 米一块水洼）。 */
	noiseScale: 0.32,
	/** 世界噪声权重（噪声主导独立水洼，凹度只破边）。 */
	noiseWeight: 0.85,
	/** 贴图凹度权重（压低以免湿贴图平铺把路面填满）。 */
	concavityWeight: 0.12,
	/** 积水分布阈值（噪声+凹度，平路目标 35–45%）。 */
	puddleDistThreshold: 0.76,
	/** 积水分布边缘过渡。 */
	puddleDistSoftness: 0.15,
	/** 高度图高出片元多少米就判定为有遮挡。 */
	skyOccludeEps: 0.25,
	/**
	 * 塘底极轻环境填亮（线性色，约 0.08～0.16）：只 × puddleMask × upFacing，
	 * 不跟涟漪纹；禁发亮色环。0 = 关。夜 ambient≈0.05 时略抬可辨底，勿过亮。
	 */
	puddleFloorLift: 0.001,
} as const

/**
 * {@link createRoadBridgeWet} 选项。城根必须已入场景并 updateMatrixWorld。
 */
export interface RoadBridgeWetOptions {
	scene: Scene
	/** 已入场景并 updateMatrixWorld 的城根。 */
	cityRoot: Object3D
	uvRepeat?: number
	roughnessScale?: number
	rippleScale?: number
	rippleSpeed?: number
	rippleAmount?: number
	rippleStrength?: number
	rippleNormalStrength?: number
	albedoBoost?: number
	opacity?: number
	albedoUrl?: string
	roughnessUrl?: string
	normalUrl?: string
	concavityEps?: number
	concavityGain?: number
	roughnessAssist?: number
	noiseMod?: number
	puddleScale?: number
	puddleThreshold?: number
	puddleSoftness?: number
	puddleOutsideRipple?: number
	/** 塘内目标粗糙度（见 ROAD_BRIDGE_WET_DEFAULTS.puddleRoughness）。 */
	puddleRoughness?: number
	/** 侧面关断 smoothstep 下沿；见 ROAD_BRIDGE_WET_DEFAULTS.sideUpMin。 */
	sideUpMin?: number
	/** 侧面关断 smoothstep 上沿；见 ROAD_BRIDGE_WET_DEFAULTS.sideUpMax。 */
	sideUpMax?: number
	/** 塘底极轻环境填亮；见 ROAD_BRIDGE_WET_DEFAULTS.puddleFloorLift。 */
	puddleFloorLift?: number
}

/**
 * 单块湿膜的几何诊断，供按高度分组镜子。
 */
interface RoadOverlayDiag {
	name: string
	centerY: number
	yMin: number
	yMax: number
	ySpan: number
	xzArea: number
	upArea: number
	meanSlopeDeg: number
	meanUpY: number
	hist: Array<{ y: number, area: number, frac: number }>
	kind: 'flat' | 'stairs' | 'slope'
}

/**
 * 一组固定高度镜面：平路走这面镜子，台阶/陡坡只留湿膜光带。
 */
export interface RoadReflectCluster {
	index: 0 | 1
	planeY: number
	flatNames: string[]
	filmOnlyNames: string[]
}

/** attachPlanarReflect 每组烤炉输入。 */
export interface RoadReflectClusterInput {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	sampleNode: any
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	uTextureMatrix: any
	planeY: number
}

/**
 * 路桥湿膜句柄。
 */
export interface RoadBridgeWetHandle {
	/** 场景中铺湿膜的张数 */
	overlayCount: number
	/** 全部湿膜网格；烤倒影前须隐藏，避免自激。 */
	overlays: Mesh[]
	/**
	 * 叠一层「只采倒影」的 Basic 叠层（ReflectOverlay_*）。
	 * 不进 RoadBridgeWetShared：本机 maxSamplers=16，标准湿膜再加 reflector 会爆到 17。
	 * 每块叠层绑所属组的 sampleNode / uTextureMatrix / planeY。
	 */
	attachPlanarReflect: (
		clusters: RoadReflectClusterInput[],
		/** 正交高度图；仅叠层采样，禁止传进湿膜材质。 */
		heightMap?: HeightMapHandle,
	) => void
	/** 倒影叠层网格；高度图渲染时须隐藏，避免反馈环。 */
	reflectOverlays: Mesh[]
	/** 两组固定高度镜面。 */
	clusters: RoadReflectCluster[]
	/** 当前生效绑定下，某组需要烘焙时要检查可见性的叠层。 */
	getClusterReflectOverlays: ( clusterIndex: number ) => Mesh[]
	update: ( dt: number ) => void
	dispose: () => void
}

function loadTexture( url: string, srgb: boolean ): Promise<Texture> {
	const loader = new TextureLoader()
	return new Promise( ( resolve, reject ) => {
		loader.load(
			url,
			( tex ) => {
				tex.wrapS = RepeatWrapping
				tex.wrapT = RepeatWrapping
				if ( srgb ) tex.colorSpace = SRGBColorSpace
				resolve( tex )
			},
			undefined,
			( err ) => reject( err ?? new Error( '纹理加载失败: ' + url ) ),
		)
	} )
}

function isRoadOrBridgeMesh( obj: Object3D ): obj is MeshType {
	if ( ( obj as MeshType ).isMesh !== true ) return false
	const name = obj.name ?? ''
	// 白名单：SM_canalBorder00/01/03/04/05 越过 INCLUDE/EXCLUDE
	if ( WET_NAME_WHITELIST.test( name ) ) return true
	if ( !ROAD_BRIDGE_NAME.test( name ) ) return false
	if ( EXCLUDE_NAME.test( name ) ) return false
	return true
}

/** 朝上面积落在任意 `window` 米高度窗内的最大占比。 */
function maxHeightWindowFrac(
	hist: Array<{ y: number, area: number }>,
	windowM: number,
	upArea: number,
): number {
	if ( upArea <= 1e-8 || hist.length === 0 ) return 1
	const sorted = [ ...hist ].sort( ( a, b ) => a.y - b.y )
	let best = 0
	let j = 0
	let sum = 0
	for ( let i = 0; i < sorted.length; i ++ ) {
		sum += sorted[ i ].area
		while ( sorted[ i ].y - sorted[ j ].y > windowM + 1e-6 ) {
			sum -= sorted[ j ].area
			j ++
		}
		if ( sum > best ) best = sum
	}
	return best / upArea
}

function analyzeOverlay( overlay: Mesh ): RoadOverlayDiag {
	overlay.updateWorldMatrix( true, false )
	const geo = overlay.geometry
	const pos = geo.getAttribute( 'position' )
	const idx = geo.getIndex()
	const e = overlay.matrixWorld.elements
	const applyMW = ( x: number, y: number, z: number ): [ number, number, number ] => {
		const w = e[ 3 ] * x + e[ 7 ] * y + e[ 11 ] * z + e[ 15 ]
		const iw = w !== 0 ? 1 / w : 1
		return [
			( e[ 0 ] * x + e[ 4 ] * y + e[ 8 ] * z + e[ 12 ] ) * iw,
			( e[ 1 ] * x + e[ 5 ] * y + e[ 9 ] * z + e[ 13 ] ) * iw,
			( e[ 2 ] * x + e[ 6 ] * y + e[ 10 ] * z + e[ 14 ] ) * iw,
		]
	}
	const triCount = pos ? ( idx ? idx.count / 3 : pos.count / 3 ) : 0
	const buckets = new Map<number, number>()
	let upArea = 0
	let slopeAreaSum = 0
	let xzArea = 0
	let yMin = Infinity
	let yMax = -Infinity
	let yWSum = 0
	if ( pos ) {
		for ( let t = 0; t < triCount; t ++ ) {
			const i0 = idx ? idx.getX( t * 3 ) : t * 3
			const i1 = idx ? idx.getX( t * 3 + 1 ) : t * 3 + 1
			const i2 = idx ? idx.getX( t * 3 + 2 ) : t * 3 + 2
			const a = applyMW( pos.getX( i0 ), pos.getY( i0 ), pos.getZ( i0 ) )
			const b = applyMW( pos.getX( i1 ), pos.getY( i1 ), pos.getZ( i1 ) )
			const c = applyMW( pos.getX( i2 ), pos.getY( i2 ), pos.getZ( i2 ) )
			const e1x = b[ 0 ] - a[ 0 ], e1y = b[ 1 ] - a[ 1 ], e1z = b[ 2 ] - a[ 2 ]
			const e2x = c[ 0 ] - a[ 0 ], e2y = c[ 1 ] - a[ 1 ], e2z = c[ 2 ] - a[ 2 ]
			const nx = e1y * e2z - e1z * e2y
			const ny = e1z * e2x - e1x * e2z
			const nz = e1x * e2y - e1y * e2x
			const twice = Math.hypot( nx, ny, nz )
			const area = twice * 0.5
			if ( area < 1e-10 ) continue
			const nny = ny / twice
			const cy = ( a[ 1 ] + b[ 1 ] + c[ 1 ] ) / 3
			yMin = Math.min( yMin, a[ 1 ], b[ 1 ], c[ 1 ] )
			yMax = Math.max( yMax, a[ 1 ], b[ 1 ], c[ 1 ] )
			xzArea += Math.abs( e1x * e2z - e1z * e2x ) * 0.5
			if ( nny > 0.55 ) {
				upArea += area
				slopeAreaSum += Math.acos( Math.min( 1, Math.max( 0, nny ) ) ) * area
				yWSum += cy * area
				const bucket = Math.round( cy * 10 ) / 10
				buckets.set( bucket, ( buckets.get( bucket ) ?? 0 ) + area )
			}
		}
	}
	if ( !geo.boundingBox ) geo.computeBoundingBox()
	const box = geo.boundingBox
	const wc = box
		? applyMW(
			( box.min.x + box.max.x ) * 0.5,
			( box.min.y + box.max.y ) * 0.5,
			( box.min.z + box.max.z ) * 0.5,
		)
		: [ 0, 0, 0 ] as [ number, number, number ]
	const hist = [ ...buckets.entries() ]
		.map( ( [ y, area ] ) => ( { y, area, frac: area / Math.max( upArea, 1e-9 ) } ) )
		.sort( ( a, b ) => a.y - b.y )
	const ySpan = Number.isFinite( yMax ) ? yMax - yMin : 0
	const meanSlopeDeg = upArea > 0 ? ( slopeAreaSum / upArea ) * 180 / Math.PI : 0
	const meanUpY = upArea > 0 ? yWSum / upArea : wc[ 1 ]
	const name = overlay.name.replace( /^WetOverlay_/, '' )
	const conc04 = maxHeightWindowFrac( hist, 0.40, upArea )
	let kind: RoadOverlayDiag[ 'kind' ] = 'flat'
	if ( /stair/i.test( name ) ) kind = 'stairs'
	else if ( ySpan >= 1.80 ) kind = 'slope'
	else if ( ySpan >= 0.80 && conc04 < 0.78 ) kind = 'slope'
	return {
		name,
		centerY: wc[ 1 ],
		yMin: Number.isFinite( yMin ) ? yMin : wc[ 1 ],
		yMax: Number.isFinite( yMax ) ? yMax : wc[ 1 ],
		ySpan,
		xzArea,
		upArea,
		meanSlopeDeg,
		meanUpY,
		hist,
		kind,
	}
}

function clusterOverlayDiags( diags: RoadOverlayDiag[] ): {
	clusters: [ RoadReflectCluster, RoadReflectCluster ]
	assignment: Array<{ cluster: 0 | 1, filmOnly: boolean }>
} {
	const flats = diags.map( ( d, i ) => ( { d, i } ) ).filter( ( x ) => x.d.kind === 'flat' )
	type Item = { d: RoadOverlayDiag, i: number, y: number, w: number }
	const items: Item[] = flats.map( ( x ) => ( {
		...x,
		y: x.d.meanUpY,
		w: Math.max( x.d.upArea, 0.01 ),
	} ) )
	items.sort( ( a, b ) => a.y - b.y )
	const weightedMean = ( arr: Item[] ): number => {
		let sw = 0, sy = 0
		for ( const it of arr ) { sw += it.w; sy += it.y * it.w }
		return sw > 0 ? sy / sw : 0
	}
	let c0 = 4
	let c1 = 6.8
	if ( items.length === 1 ) {
		c0 = items[ 0 ].y
		c1 = items[ 0 ].y + 2
	} else if ( items.length >= 2 ) {
		const totalW = items.reduce( ( s, it ) => s + it.w, 0 )
		let acc = 0
		let split = Math.max( 1, items.length - 1 )
		for ( let i = 0; i < items.length; i ++ ) {
			acc += items[ i ].w
			if ( acc >= totalW * 0.5 ) {
				split = Math.max( 1, i )
				break
			}
		}
		c0 = weightedMean( items.slice( 0, split ) )
		c1 = weightedMean( items.slice( split ) )
		if ( c0 > c1 ) { const t = c0; c0 = c1; c1 = t }
		for ( let iter = 0; iter < 8; iter ++ ) {
			const g0: Item[] = []
			const g1: Item[] = []
			for ( const it of items ) {
				( Math.abs( it.y - c0 ) <= Math.abs( it.y - c1 ) ? g0 : g1 ).push( it )
			}
			if ( g0.length === 0 || g1.length === 0 ) break
			c0 = weightedMean( g0 )
			c1 = weightedMean( g1 )
		}
		if ( c0 > c1 ) { const t = c0; c0 = c1; c1 = t }
	}

	const groups: [ RoadOverlayDiag[], RoadOverlayDiag[] ] = [ [], [] ]
	const assignment: Array<{ cluster: 0 | 1, filmOnly: boolean }> = diags.map( ( d ) => {
		const filmOnly = d.kind !== 'flat'
		const cluster: 0 | 1 = Math.abs( d.meanUpY - c0 ) <= Math.abs( d.meanUpY - c1 ) ? 0 : 1
		if ( !filmOnly ) groups[ cluster ].push( d )
		return { cluster, filmOnly }
	} )

	const modalPlaneY = ( group: RoadOverlayDiag[], fallback: number ): number => {
		const bucket = new Map<number, number>()
		for ( const d of group ) {
			for ( const h of d.hist ) {
				bucket.set( h.y, ( bucket.get( h.y ) ?? 0 ) + h.area )
			}
		}
		let bestY = fallback
		let bestA = -1
		for ( const [ y, a ] of bucket ) {
			if ( a > bestA ) { bestA = a; bestY = y }
		}
		return bestY
	}
	const planeY0 = modalPlaneY( groups[ 0 ], c0 )
	const planeY1 = modalPlaneY( groups[ 1 ], c1 )
	const filmOnlyNames: [ string[], string[] ] = [ [], [] ]
	for ( let i = 0; i < diags.length; i ++ ) {
		if ( !assignment[ i ].filmOnly ) continue
		const y = diags[ i ].meanUpY
		assignment[ i ].cluster = Math.abs( y - planeY0 ) <= Math.abs( y - planeY1 ) ? 0 : 1
		filmOnlyNames[ assignment[ i ].cluster ].push( diags[ i ].name )
	}
	return {
		clusters: [
			{ index: 0, planeY: planeY0, flatNames: groups[ 0 ].map( ( d ) => d.name ), filmOnlyNames: filmOnlyNames[ 0 ] },
			{ index: 1, planeY: planeY1, flatNames: groups[ 1 ].map( ( d ) => d.name ), filmOnlyNames: filmOnlyNames[ 1 ] },
		],
		assignment,
	}
}

/**
 * 在城内路 / 桥 / 石阶网格上叠积水涟漪膜。
 *
 * @param options - 场景、城根与可调参。
 * @returns 句柄（update / dispose / 计数）。
 */
export async function createRoadBridgeWet(
	options: RoadBridgeWetOptions,
): Promise<RoadBridgeWetHandle> {
	const {
		scene,
		cityRoot,
		uvRepeat = ROAD_BRIDGE_WET_DEFAULTS.uvRepeat,
		roughnessScale = ROAD_BRIDGE_WET_DEFAULTS.roughnessScale,
		rippleScale = ROAD_BRIDGE_WET_DEFAULTS.rippleScale,
		rippleSpeed = ROAD_BRIDGE_WET_DEFAULTS.rippleSpeed,
		rippleAmount = ROAD_BRIDGE_WET_DEFAULTS.rippleAmount,
		rippleStrength = ROAD_BRIDGE_WET_DEFAULTS.rippleStrength,
		rippleNormalStrength = ROAD_BRIDGE_WET_DEFAULTS.rippleNormalStrength,
		albedoBoost = ROAD_BRIDGE_WET_DEFAULTS.albedoBoost,
		opacity = ROAD_BRIDGE_WET_DEFAULTS.opacity,
		albedoUrl = ROAD_BRIDGE_WET_DEFAULTS.albedoUrl,
		roughnessUrl = ROAD_BRIDGE_WET_DEFAULTS.roughnessUrl,
		normalUrl = ROAD_BRIDGE_WET_DEFAULTS.normalUrl,
		concavityEps = ROAD_BRIDGE_WET_DEFAULTS.concavityEps,
		concavityGain = ROAD_BRIDGE_WET_DEFAULTS.concavityGain,
		roughnessAssist = ROAD_BRIDGE_WET_DEFAULTS.roughnessAssist,
		noiseMod = ROAD_BRIDGE_WET_DEFAULTS.noiseMod,
		puddleScale = ROAD_BRIDGE_WET_DEFAULTS.puddleScale,
		puddleThreshold = ROAD_BRIDGE_WET_DEFAULTS.puddleThreshold,
		puddleSoftness = ROAD_BRIDGE_WET_DEFAULTS.puddleSoftness,
		puddleOutsideRipple = ROAD_BRIDGE_WET_DEFAULTS.puddleOutsideRipple,
		puddleRoughness = ROAD_BRIDGE_WET_DEFAULTS.puddleRoughness,
		sideUpMin = ROAD_BRIDGE_WET_DEFAULTS.sideUpMin,
		sideUpMax = ROAD_BRIDGE_WET_DEFAULTS.sideUpMax,
		puddleFloorLift = ROAD_BRIDGE_WET_DEFAULTS.puddleFloorLift,
	} = options
	void scene

	const [ albedoMap, roughnessMap, normalTex ] = await Promise.all( [
		loadTexture( albedoUrl, true ),
		loadTexture( roughnessUrl, false ),
		loadTexture( normalUrl, false ),
	] )

	const uUvRepeat = uniform( uvRepeat )
	const uRoughnessScale = uniform( roughnessScale )
	const uTime = uniform( 0 )
	const uRippleAmount = uniform( rippleAmount )
	const uRippleScale = uniform( rippleScale )
	const uRippleSpeed = uniform( rippleSpeed )
	const uRippleStrength = uniform( rippleStrength )
	const uRippleNormalStrength = uniform( rippleNormalStrength )
	const uAlbedoBoost = uniform( albedoBoost )
	const uOpacity = uniform( opacity )
	const uConcavityEps = uniform( concavityEps )
	const uConcavityGain = uniform( concavityGain )
	const uRoughnessAssist = uniform( roughnessAssist )
	const uNoiseMod = uniform( noiseMod )
	const uPuddleScale = uniform( puddleScale )
	const uPuddleThreshold = uniform( puddleThreshold )
	const uPuddleSoftness = uniform( puddleSoftness )
	const uPuddleOutsideRipple = uniform( puddleOutsideRipple )
	/** 塘内目标粗糙度；与贴图粗糙按 mask 混合。 */
	const uPuddleRoughness = uniform( puddleRoughness )
	/** 侧面关断：法线朝上 smoothstep 下沿。 */
	const uSideUpMin = uniform( sideUpMin )
	/** 侧面关断：法线朝上 smoothstep 上沿。 */
	const uSideUpMax = uniform( sideUpMax )
	/** 塘底极轻环境填亮强度（线性）；只乘积水×朝上，不乘涟漪。 */
	const uPuddleFloorLift = uniform( puddleFloorLift )

		const rippleFn = createRippleFn( { uTime, uRippleSpeed } )

	// 未加涟漪偏移的 tiled UV：凹度 mask 不随环游走
	const baseUv = uv().mul( uUvRepeat )
	const puddleMask = createPuddleMaskNode( {
		normalMap: normalTex,
		roughnessMap,
		baseUv,
		worldXZ: positionWorld.xz,
		uConcavityEps,
		uConcavityGain,
		uRoughnessAssist,
		uNoiseMod,
		uPuddleScale,
		uPuddleThreshold,
		uPuddleSoftness,
	} )

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const ripple = ( rippleFn as any )( positionWorld.xz.mul( uRippleScale ) )
	/**
	 * 只保留近似水平面：世界几何法线 Y 高 → 朝上；
	 * 石柱/桥帮立面法线近水平 → 门控为 0（侧面无涟漪、无倒影）。
	 */
	const upFacing = smoothstep( uSideUpMin, uSideUpMax, normalWorldGeometry.y )
	// outside≈0：非积水灭环；再乘 upFacing 灭侧面
	const rippleGate = puddleRippleGate( puddleMask, uPuddleOutsideRipple ).mul( upFacing )
	const rippleUvOffset = ripple.xy.mul( uRippleAmount ).mul( uRippleStrength ).mul( rippleGate )
	const rippleNrmOffset = ripple.xy.mul( uRippleAmount ).mul( uRippleNormalStrength ).mul( rippleGate )

	const tiledUv = baseUv.add( rippleUvOffset )
	const roughnessSample = texture( roughnessMap, tiledUv ).r
	const albedoSample = texture( albedoMap, tiledUv )
	const normalSample = texture( normalTex, tiledUv )

	const warpedNormalTex = vec4(
		normalSample.x.add( rippleNrmOffset.x ),
		normalSample.y.add( rippleNrmOffset.y ),
		normalSample.z,
		normalSample.w,
	)

	const material = new MeshStandardNodeMaterial()
	material.name = 'RoadBridgeWetShared'
	material.transparent = true
	// 贴花湿膜：禁止写深度。叶（如 Material_26_0 BLEND）depthWrite=false；
	// 若湿膜后画且写深度，屏幕与路桥/石阶重叠处会盖住叶，树序看起来错乱。
	material.depthWrite = false
	// 金属度保持默认 0（电介质湿面）；倒影由平面烤图叠层负责，不再假金属度门控。
	material.polygonOffset = true
	// 加大偏移，减轻桥面/石阶与原网格抢深度导致「看不见叠膜」
	material.polygonOffsetFactor = -5
	material.polygonOffsetUnits = -5
	// 塘内压低粗糙 → 镜面更清晰；塘外仍用湿贴图×scale
	material.roughnessNode = mix(
		roughnessSample.mul( uRoughnessScale ),
		uPuddleRoughness,
		puddleMask,
	)
	material.normalNode = normalMap( warpedNormalTex )
	const floorLiftRgb = vec3(
		uPuddleFloorLift.mul( float( 0.88 ) ),
		uPuddleFloorLift,
		uPuddleFloorLift.mul( float( 1.12 ) ),
	)
	const wetAlbedo = albedoSample.rgb.mul( uAlbedoBoost ).add( floorLiftRgb.mul( puddleMask ) )
	material.colorNode = wetAlbedo
	material.opacityNode = uOpacity.mul( upFacing )
	const floorLift = floorLiftRgb.mul( puddleMask ).mul( upFacing )
	material.emissiveNode = floorLift

	const sources: MeshType[] = []
	cityRoot.traverse( ( obj ) => {
		if ( isRoadOrBridgeMesh( obj ) ) sources.push( obj )
	} )

	const overlays: Mesh[] = []

	for ( const src of sources ) {
		const overlay = new Mesh( src.geometry, material )
		overlay.name = 'WetOverlay_' + ( src.name || 'mesh' )
		overlay.renderOrder = -1 // 先于默认透明叶(0)与雨丝(11+)，避免湿膜后画盖叶
		overlay.receiveShadow = true
		overlay.castShadow = false
		overlay.position.copy( src.position )
		overlay.quaternion.copy( src.quaternion )
		overlay.scale.copy( src.scale )
		src.parent?.add( overlay )
		overlay.updateMatrix()
		overlays.push( overlay )
	}

	const overlayDiags = overlays.map( ( o ) => analyzeOverlay( o ) )
	const clustered = clusterOverlayDiags( overlayDiags )
	const roadClusters = clustered.clusters
	const overlayBinds = clustered.assignment

	/**
	 * 在每张湿膜上再克隆一张 ReflectOverlay：uTextureMatrix 投影对齐镜面烤图。
	 * 每块绑所属组的 sampleNode / planeY；台阶/陡坡 uPuddleEnable=0。
	 * 禁止对 textureMatrix 结果再加 0.5 偏置；禁止把流动偏移加到整幅 UV。
	 */
	const reflectOverlays: Mesh[] = []
	const clusterOverlayLists: [ Mesh[], Mesh[] ] = [ [], [] ]
	const reflectMaterials: MeshBasicNodeMaterial[] = []
	/** [cluster][puddleOn ? 1 : 0] */
	const clusterMats: MeshBasicNodeMaterial[][] = [ [], [] ]
	const uReflectBlurMax = uniform( ROAD_BRIDGE_WET_DEFAULTS.reflectBlurMax )
	const uFresnelF0 = uniform( ROAD_BRIDGE_WET_DEFAULTS.fresnelF0 )
	const uReflectStrength = uniform( 2.5 )
	const uPuddleStreak = uniform( ROAD_BRIDGE_WET_DEFAULTS.puddleStreak )
	const uFilmReflect = uniform( ROAD_BRIDGE_WET_DEFAULTS.filmReflect )
	const uFilmStreak = uniform( ROAD_BRIDGE_WET_DEFAULTS.filmStreak )
	const uFilmBlur = uniform( ROAD_BRIDGE_WET_DEFAULTS.filmBlur )
	const uFilmLod = uniform( ROAD_BRIDGE_WET_DEFAULTS.filmLod )
	const uReflectNormalWarp = uniform( ROAD_BRIDGE_WET_DEFAULTS.reflectNormalWarp )
	const uWarpRefDepth = uniform( ROAD_BRIDGE_WET_DEFAULTS.warpRefDepth )
	const uPlaneFadeNear = uniform( ROAD_BRIDGE_WET_DEFAULTS.planeFadeNear )
	const uPlaneFadeFar = uniform( ROAD_BRIDGE_WET_DEFAULTS.planeFadeFar )
	const uFilmFadeNear = uniform( ROAD_BRIDGE_WET_DEFAULTS.filmFadeNear )
	const uFilmFadeFar = uniform( ROAD_BRIDGE_WET_DEFAULTS.filmFadeFar )
	const uPlaneY0 = uniform( roadClusters[ 0 ].planeY )
	const uPlaneY1 = uniform( roadClusters[ 1 ].planeY )
	const uNoiseScale = uniform( ROAD_BRIDGE_WET_DEFAULTS.noiseScale )
	const uNoiseWeight = uniform( ROAD_BRIDGE_WET_DEFAULTS.noiseWeight )
	const uConcavityWeight = uniform( ROAD_BRIDGE_WET_DEFAULTS.concavityWeight )
	const uPuddleDistThreshold = uniform( ROAD_BRIDGE_WET_DEFAULTS.puddleDistThreshold )
	const uPuddleDistSoftness = uniform( ROAD_BRIDGE_WET_DEFAULTS.puddleDistSoftness )
	const uSkyOccludeEps = uniform( ROAD_BRIDGE_WET_DEFAULTS.skyOccludeEps )

	const attachPlanarReflect = (
		clusterInputs: RoadReflectClusterInput[],
		heightMap?: HeightMapHandle,
	): void => {
		if ( reflectMaterials.length > 0 ) return
		const c0 = clusterInputs[ 0 ]
		const c1 = clusterInputs[ 1 ] ?? clusterInputs[ 0 ]
		if ( !c0 ) return
		uPlaneY0.value = c0.planeY
		if ( c1 ) uPlaneY1.value = c1.planeY

		const buildReflectMaterial = (
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			reflectSampleNode: any,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			uTextureMatrix: any,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			uClusterPlaneY: any,
			puddleOn: boolean,
		): MeshBasicNodeMaterial => {
			const uPuddleEnable = uniform( puddleOn ? 1 : 0 )
			const mat = new MeshBasicNodeMaterial()
			mat.name = 'PlanarPuddleReflectOverlay'
			mat.transparent = true
			mat.depthWrite = false
			mat.blending = AdditiveBlending
			mat.polygonOffset = true
			mat.polygonOffsetFactor = -6
			mat.polygonOffsetUnits = -6

			const reflectEffRoughness = mix(
				roughnessSample.mul( uRoughnessScale ),
				uPuddleRoughness,
				puddleMask,
			)
			const reflectGloss = saturate( float( 1 ).sub( reflectEffRoughness ) )

			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const uvInside = ( uvNode: any ) =>
				uvNode.x.greaterThanEqual( 0 ).and( uvNode.x.lessThanEqual( 1 ) )
					.and( uvNode.y.greaterThanEqual( 0 ) ).and( uvNode.y.lessThanEqual( 1 ) )

			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			let exposure: any = float( 1 )
			if ( heightMap ) {
				const heightTex = heightMap.renderTarget.texture
				const texelWorld = HEIGHT_MAP_DEFAULTS.width / HEIGHT_MAP_DEFAULTS.resolution
				const jitterAmp = texelWorld * 0.55
				const jx = mx_noise_float( positionWorld.xz.mul( 1.73 ), jitterAmp, 0 )
				const jz = mx_noise_float( positionWorld.xz.mul( 2.09 ).add( vec2( 13.7, 4.1 ) ), jitterAmp, 0 )
				const sampleOrigin = positionWorld.add( vec3( jx, 0, jz ) )
				const heightUv = heightMap.getUV( sampleOrigin )
				const centerInside = uvInside( heightUv )
				const hC = texture( heightTex, heightUv ).y
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				let occludeMin: any = hC.sub( positionWorld.y )
				const diagOffsets: Array<[ number, number ]> = [
					[ texelWorld, texelWorld ], [ texelWorld, -texelWorld ],
					[ -texelWorld, texelWorld ], [ -texelWorld, -texelWorld ],
				]
				for ( const [ dx, dz ] of diagOffsets ) {
					const nPos = sampleOrigin.add( vec3( dx, 0, dz ) )
					const nUv = heightMap.getUV( nPos )
					const nInside = uvInside( nUv )
					const hN = texture( heightTex, nUv ).y
					const occN = select( nInside, hN.sub( positionWorld.y ), float( 0 ) )
					occludeMin = occludeMin.min( occN )
				}
				const exposureIn = float( 1 ).sub(
					smoothstep( uSkyOccludeEps, uSkyOccludeEps.add( 0.6 ), occludeMin ),
				)
				exposure = select( centerInside, exposureIn, float( 1 ) )
			}

			const noise = mx_noise_float( positionWorld.xz.mul( uNoiseScale ), 0.5, 0.5 )
			const concavity = puddleMask
			const raw = uNoiseWeight.mul( noise ).add( uConcavityWeight.mul( concavity ) )
			const puddle = smoothstep(
				uPuddleDistThreshold.sub( uPuddleDistSoftness ),
				uPuddleDistThreshold.add( uPuddleDistSoftness ),
				raw,
			).mul( exposure ).mul( upFacing ).mul( uPuddleEnable )
			const film = exposure.mul( upFacing ).mul( float( 1 ).sub( puddle ) )

			const mirrorClip = uTextureMatrix.mul( vec4( positionWorld, 1.0 ) )
			const warpScale = uReflectNormalWarp.mul( uWarpRefDepth.div( mirrorClip.w.max( uWarpRefDepth ) ) )
			const rippleWarp = ripple.xy.mul( warpScale ).mul( puddle )
			const mirrorUv = mirrorClip.xy.div( mirrorClip.w ).flipY()
			const reflectBaseUv = mirrorUv.add( rippleWarp )

			// uFilmStreak 为总长度，间距 = 总长/6；水洼仍用单步间距。
			const streakStep = mix( uPuddleStreak, uFilmStreak.div( float( 6 ) ), film )
			const blurR = mix( uReflectBlurMax, uFilmBlur, film )
			const filmLodAmount = mix( float( 0 ), uFilmLod, film )
			const ign = interleavedGradientNoise( viewportCoordinate )
			const jitterV = ign.sub( 0.5 ).mul( streakStep ).mul( film )
			const lodForSpan = ( kAbs: number ) =>
				filmLodAmount.mul( float( 0.6 + 0.4 * ( kAbs / 3 ) ) )
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const sampleReflect = ( du: any, dv: any, kAbs: number ) =>
				reflectSampleNode.level( lodForSpan( kAbs ) ).sample(
					reflectBaseUv.add( vec2( du, dv.add( jitterV ) ) ),
				)
			const tC0 = sampleReflect( float( 0 ), float( 0 ), 0 )
			const tC1 = sampleReflect( blurR, float( 0 ), 0 )
			const tC2 = sampleReflect( blurR.negate(), float( 0 ), 0 )
			const tCenter = tC0.add( tC1 ).add( tC2 ).mul( float( 1 ).div( float( 3 ) ) )
			const streakWeights = [ 1, 2, 3, 4, 3, 2, 1 ]
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			let streaked: any = tCenter.mul( float( streakWeights[ 3 ] ) )
			for ( const k of [ -3, -2, -1, 1, 2, 3 ] ) {
				const w = streakWeights[ k + 3 ]
				const sample = sampleReflect(
					float( 0 ),
					streakStep.mul( float( k ) ),
					Math.abs( k ),
				)
				streaked = streaked.add( sample.mul( float( w ) ) )
			}
			streaked = streaked.mul( float( 1 ).div( float( 16 ) ) )

			const roadN = normalize( normalWorldGeometry )
			const viewDir = normalize( cameraPosition.sub( positionWorld ) )
			const nDotV = dot( roadN, viewDir ).max( float( 0 ) )
			const fresnelF = uFresnelF0.add(
				float( 1 ).sub( uFresnelF0 ).mul( float( 1 ).sub( nDotV ).pow( 5 ) ),
			)
			const dy = positionWorld.y.sub( uClusterPlaneY ).abs()
			const puddleFade = float( 1 ).sub( smoothstep( uPlaneFadeNear, uPlaneFadeFar, dy ) )
			const filmFade = float( 1 ).sub( smoothstep( uFilmFadeNear, uFilmFadeFar, dy ) )
			const reflectMask = puddle.mul( puddleFade ).add( film.mul( uFilmReflect ).mul( filmFade ) )
			mat.colorNode = streaked.rgb.mul( fresnelF ).mul( uReflectStrength ).mul( reflectMask ).mul( reflectGloss )
			mat.opacityNode = float( 1 )
			return mat
		}

		clusterMats[ 0 ][ 1 ] = buildReflectMaterial( c0.sampleNode, c0.uTextureMatrix, uPlaneY0, true )
		clusterMats[ 0 ][ 0 ] = buildReflectMaterial( c0.sampleNode, c0.uTextureMatrix, uPlaneY0, false )
		clusterMats[ 1 ][ 1 ] = buildReflectMaterial( c1.sampleNode, c1.uTextureMatrix, uPlaneY1, true )
		clusterMats[ 1 ][ 0 ] = buildReflectMaterial( c1.sampleNode, c1.uTextureMatrix, uPlaneY1, false )
		for ( const row of clusterMats ) {
			for ( const mat of row ) {
				if ( mat ) reflectMaterials.push( mat )
			}
		}

		for ( let i = 0; i < overlays.length; i ++ ) {
			const src = overlays[ i ]
			const bind = overlayBinds[ i ]
			const ci = bind?.cluster ?? 0
			const mat = clusterMats[ ci ][ bind?.filmOnly ? 0 : 1 ]
			const mirror = new Mesh( src.geometry, mat )
			mirror.name = 'ReflectOverlay_' + ( src.name.replace( /^WetOverlay_/, '' ) || 'mesh' )
			mirror.renderOrder = 0
			mirror.receiveShadow = false
			mirror.castShadow = false
			mirror.position.copy( src.position )
			mirror.quaternion.copy( src.quaternion )
			mirror.scale.copy( src.scale )
			src.parent?.add( mirror )
			mirror.updateMatrix()
			reflectOverlays.push( mirror )
			clusterOverlayLists[ ci ].push( mirror )
		}
	}

	const getClusterReflectOverlays = ( clusterIndex: number ): Mesh[] => {
		return clusterOverlayLists[ clusterIndex === 1 ? 1 : 0 ]
	}

	const update = ( dt: number ): void => {
		uTime.value += dt
	}

	let disposed = false
	const dispose = (): void => {
		if ( disposed ) return
		disposed = true
		for ( const overlay of overlays ) {
			overlay.parent?.remove( overlay )
		}
		overlays.length = 0
		for ( const mirror of reflectOverlays ) {
			mirror.parent?.remove( mirror )
		}
		reflectOverlays.length = 0
		for ( const mat of reflectMaterials ) mat.dispose()
		reflectMaterials.length = 0
		material.dispose()
		albedoMap.dispose()
		roughnessMap.dispose()
		normalTex.dispose()
	}

	return {
		overlayCount: overlays.length,
		overlays,
		reflectOverlays,
		clusters: roadClusters,
		getClusterReflectOverlays,
		attachPlanarReflect,
		update,
		dispose,
	}
}

