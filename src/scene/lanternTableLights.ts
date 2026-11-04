/**
 * 按 models/lantern-positions.json 的 gltf_*（Y-up）在城根局部坐标创建点光源。
 *
 * loadCity 对城模做了等比缩放 appliedScale=48/最长边，再 root.position.y 贴地；
 * 表坐标是加载归一化前的 GLTF 空间。用 cityRoot.localToWorld(gltf_*) 得到世界坐标后挂到场景，
 * 与真灯笼 mesh 同空间。
 * 勿用 Blender 的 x/y/z（Z-up）；勿再按 AABB/屋檐中线猜位当正式灯位来源。
 */

import {
	Box3,
	Object3D,
	PointLight,
	Vector3,
	type Group,
	type Scene,
} from 'three'

import {
	LANTERN_FLICKER_USERDATA_KEY,
	type LanternFlickerLightMeta,
} from './createLanternFlicker'

/** 与真灯笼点光同系的暖白纸灯色（少一点脏橙）。 */
const TABLE_LIGHT_COLOR = 0xffd4a8

/** 独立灯笼（真节点）默认点光强度。 */
const INTENSITY_INDEPENDENT = 24

/** 屋檐/烤串串灯（merged）默认点光强度。 */
const INTENSITY_MERGED = 18

/** 独立灯笼衰减距离。只拉半径、不加强度，让灯池照到巷子，灯芯不过曝。 */
const DISTANCE_INDEPENDENT = 10

/** 屋檐/烤串串灯衰减距离。略远于独立灯，照到近墙和湿地面。 */
const DISTANCE_MERGED = 14

/**
 * 点光阴影贴图像素边长（须为 2 的幂）。
 * 仅 6 盏独立灯开立方体阴影（6 面 × 256²），加载后烘一次，平时不每帧重画。
 */
const SHADOW_MAP_SIZE = 256

/** 运行时拉取表的默认 URL（对应 public/models/lantern-positions.json）。 */
const DEFAULT_TABLE_URL = '/models/lantern-positions.json'

/**
 * 表中单条灯位记录（正式灯位只用 gltf_*；其余字段供审阅/分类）。
 */
export interface LanternTableEntry {
	id: string
	name: string
	gltf_x: number
	gltf_y: number
	gltf_z: number
	light_kind?: string
	anchor?: string
	source?: string
	note?: string
}

/**
 * lantern-positions.json 顶层结构。
 */
export interface LanternPositionsFile {
	meta: { count: number; [key: string]: unknown }
	lanterns: LanternTableEntry[]
}

/**
 * {@link setupLanternTableLights} 可选参数。
 */
export interface LanternTableLightsOptions {
	/**
	 * 表的绝对或站点根路径 URL。
	 * @defaultValue `'/models/lantern-positions.json'`
	 */
	url?: string
	/**
	 * 是否开启阴影。默认关；App 当前显式打开。
	 * @defaultValue `false`
	 */
	enableShadows?: boolean
	/**
	 * loadCity 返回的 appliedScale，仅写入结果与核验日志，不参与二次缩放
	 * （缩放已由 cityRoot.scale 承担）。
	 */
	appliedScale?: number
}

/**
 * 读表建光结果。
 */
export interface LanternTableLightsResult {
	/** 按表创建的全部点光（期望与 meta.count 一致，当前为 23）。 */
	lights: PointLight[]
	/** 表 meta.count。 */
	tableCount: number
	/** 实际创建数量。 */
	litCount: number
	/** 调用方传入的 appliedScale（便于对照日志）。 */
	appliedScale: number
	/**
	 * 核验摘要：独立真灯笼 mesh 世界 AABB 中心 vs 表灯世界坐标偏差。
	 * 空数组表示城根下未找到可对名的真灯笼节点。
	 */
	verify: {
		name: string
		meshWorld: [number, number, number]
		tableWorld: [number, number, number]
		dist: number
	}[]
	/** 开启阴影的点光数量（enableShadows 为 false 时为 0）。 */
	shadowCasterCount: number
	/** 阴影贴图像素边长（与 SHADOW_MAP_SIZE 一致）。 */
	shadowMapSize: number
	/**
	 * 手动请求下一帧烘阴影贴图。
	 * WebGPU 路径下没有 renderer.shadowMap.autoUpdate，
	 * 须对每盏灯设 shadow.needsUpdate = true；灯与挡光 mesh 不动则只需调用一次。
	 */
	requestShadowUpdate: () => void
	/**
	 * 灯位静态，只需在入场景后调用一次 `updateMatrixWorld`。
	 * 主循环不必每帧调用。
	 */
	update: () => void
	dispose: () => void
}

/**
 * 拉取 lantern-positions.json 并校验 gltf_* 字段。
 *
 * @param url - 站点根相对或绝对 URL。
 * @returns 解析后的表。
 */
async function fetchLanternPositions( url = DEFAULT_TABLE_URL ): Promise<LanternPositionsFile> {
	const res = await fetch( url )
	if ( ! res.ok ) {
		throw new Error( `[lanternTableLights] 拉取灯位表失败: ${res.status} ${url}` )
	}
	const data = ( await res.json() ) as LanternPositionsFile
	if ( ! Array.isArray( data.lanterns ) || data.lanterns.length === 0 ) {
		throw new Error( '[lanternTableLights] 表中 lanterns 为空' )
	}
	for ( const entry of data.lanterns ) {
		if (
			typeof entry.gltf_x !== 'number' ||
			typeof entry.gltf_y !== 'number' ||
			typeof entry.gltf_z !== 'number'
		) {
			throw new Error( `[lanternTableLights] 条目缺少 gltf_*: ${entry.id ?? entry.name}` )
		}
	}
	return data
}

/**
 * 是否为可与城模真灯笼节点名对齐的独立灯笼名。
 *
 * @param name - 表条目 name 或 mesh 名。
 */
function isIndependentLanternName( name: string ): boolean {
	return (
		/^SM_WoodenLantern\d*$/.test( name ) ||
		/^SM_bigLantern\d*$/.test( name ) ||
		/^SM_festivalLantern\d*$/.test( name )
	)
}

/**
 * 点光阴影强度（0~1）。全开关键灯后阴影偏重，略压暗以免糊成一片。
 */
const SHADOW_INTENSITY = 0.45

/**
 * 允许投影的独立灯：两盏大灯、祭典灯、三根木灯杆。
 * 其余点光 `castShadow=false`，由 {@link ClusteredLighting} 按 cluster 着色。
 */
const SHADOW_CASTER_NAMES = new Set( [
	'SM_bigLantern',
	'SM_bigLantern003',
	'SM_festivalLantern',
	'SM_WoodenLantern001',
	'SM_WoodenLantern003',
	'SM_WoodenLantern005',
] )

function meshWorldAabbCenter( root: Object3D, out: Vector3 ): Vector3 {
	root.updateMatrixWorld( true )
	const box = new Box3()
	box.makeEmpty()
	let any = false
	root.traverse( ( child ) => {
		const mesh = child as Object3D & { isMesh?: boolean }
		if ( mesh.isMesh === true ) {
			box.expandByObject( child )
			any = true
		}
	} )
	if ( ! any || box.isEmpty() ) {
		root.getWorldPosition( out )
		return out
	}
	box.getCenter( out )
	return out
}

/**
 * 在城根下按表创建全部点光；局部坐标 = gltf_*，世界坐标由城根缩放+贴地自动变换。
 *
 * 性能：建齐表内全部点光（当前 23）；仅 6 盏独立灯投影，其余走 ClusteredLighting。
 * 边界：不改 GLB；不写湿膜/倒影/涟漪；真灯笼 emissive 仍由 lanternEmissive.ts 负责。
 *
 * @param scene - 主场景。
 * @param cityRoot - {@link loadCity} 返回的城根（已含 appliedScale 与贴地）。
 * @param options - 表 URL / 阴影 / appliedScale 日志。
 * @returns 统计、核验、update、dispose。
 */
export async function setupLanternTableLights(
	scene: Scene,
	cityRoot: Group | Object3D,
	options: LanternTableLightsOptions = {},
): Promise<LanternTableLightsResult> {
	const url = options.url ?? DEFAULT_TABLE_URL
	const enableShadows = options.enableShadows ?? false
	const appliedScale = options.appliedScale ?? ( cityRoot.scale?.x ?? 1 )

	const table = await fetchLanternPositions( url )
	cityRoot.updateMatrixWorld( true )

	const lights: PointLight[] = []
	const scratchLocal = new Vector3()
	const scratchWorld = new Vector3()

	for ( const entry of table.lanterns ) {
		const independent = isIndependentLanternName( entry.name )
		const intensity = independent ? INTENSITY_INDEPENDENT : INTENSITY_MERGED
		const distance = independent ? DISTANCE_INDEPENDENT : DISTANCE_MERGED

		const light = new PointLight( TABLE_LIGHT_COLOR, intensity, distance, 2 )
		light.name = `TablePoint_${entry.id}_${entry.name}`
		const flickerMeta: LanternFlickerLightMeta = {
			base: intensity,
			independent,
			key: entry.name,
		}
		light.userData[ LANTERN_FLICKER_USERDATA_KEY ] = flickerMeta
		const wantShadow = enableShadows && SHADOW_CASTER_NAMES.has( entry.name )
		light.castShadow = wantShadow
		if ( wantShadow ) {
			// 点光阴影是 6 面立方体深度图；far 对齐灯光 distance，避免远处空刷。
			light.shadow.mapSize.set( SHADOW_MAP_SIZE, SHADOW_MAP_SIZE )
			light.shadow.camera.near = 0.2
			light.shadow.camera.far = distance
			light.shadow.bias = -0.001
			light.shadow.normalBias = 0.02
			// 关自动更新：灯位与城模静态，只在 App 加载齐套后 requestShadowUpdate 一次。
			light.shadow.autoUpdate = false
			light.shadow.needsUpdate = false
			light.shadow.intensity = SHADOW_INTENSITY
		}
		// 表 gltf_* 是加载前 GLTF 局部；经城根 localToWorld 得到与 mesh 一致的世界坐标
		// （内含 appliedScale 与贴地 y 偏移）。
		scratchLocal.set( entry.gltf_x, entry.gltf_y, entry.gltf_z )
		cityRoot.localToWorld( scratchLocal )
		light.position.copy( scratchLocal )
		scene.add( light )
		lights.push( light )
	}

	// 核验：独立真灯笼 mesh 世界中心 vs 对应表灯世界坐标。
	const shadowCasterNames = lights.filter( ( l ) => l.castShadow ).map( ( l ) => l.name )
	console.info( '[lanternTableLights] 关键灯阴影', {
		enableShadows,
		shadowCasterCount: shadowCasterNames.length,
		shadowCasterNames,
		shadowMapSize: SHADOW_MAP_SIZE,
	} )

	const verify: LanternTableLightsResult['verify'] = []
	const nameToMesh = new Map<string, Object3D>()
	cityRoot.traverse( ( obj ) => {
		if ( isIndependentLanternName( obj.name ) && ! nameToMesh.has( obj.name ) ) {
			nameToMesh.set( obj.name, obj )
		}
	} )
	for ( const entry of table.lanterns ) {
		if ( ! isIndependentLanternName( entry.name ) ) continue
		const meshRoot = nameToMesh.get( entry.name )
		if ( ! meshRoot ) continue
		meshWorldAabbCenter( meshRoot, scratchLocal )
		const meshWorld: [number, number, number] = [
			+scratchLocal.x.toFixed( 4 ),
			+scratchLocal.y.toFixed( 4 ),
			+scratchLocal.z.toFixed( 4 ),
		]
		scratchWorld.set( entry.gltf_x, entry.gltf_y, entry.gltf_z )
		cityRoot.localToWorld( scratchWorld )
		const tableWorld: [number, number, number] = [
			+scratchWorld.x.toFixed( 4 ),
			+scratchWorld.y.toFixed( 4 ),
			+scratchWorld.z.toFixed( 4 ),
		]
		const dx = meshWorld[ 0 ] - tableWorld[ 0 ]
		const dy = meshWorld[ 1 ] - tableWorld[ 1 ]
		const dz = meshWorld[ 2 ] - tableWorld[ 2 ]
		const dist = +Math.sqrt( dx * dx + dy * dy + dz * dz ).toFixed( 4 )
		verify.push( { name: entry.name, meshWorld, tableWorld, dist } )
	}

	console.info( '[lanternTableLights] 读表建光', {
		tableCount: table.meta?.count ?? table.lanterns.length,
		litCount: lights.length,
		appliedScale,
		cityRootScale: { x: cityRoot.scale.x, y: cityRoot.scale.y, z: cityRoot.scale.z },
		cityRootPosY: cityRoot.position.y,
		verify,
	} )

	const shadowCasterCount = lights.filter( ( l ) => l.castShadow ).length

	return {
		lights,
		tableCount: table.meta?.count ?? table.lanterns.length,
		litCount: lights.length,
		appliedScale,
		verify,
		shadowCasterCount,
		shadowMapSize: SHADOW_MAP_SIZE,
		requestShadowUpdate: () => {
			if ( ! enableShadows ) return
			for ( const light of lights ) {
				if ( ! light.castShadow ) continue
				light.shadow.needsUpdate = true
			}
			console.info( '[lanternTableLights] 请求静态阴影烘培', {
				shadowCasterCount,
				shadowMapSize: SHADOW_MAP_SIZE,
			} )
		},
		update: () => {
			for ( const light of lights ) {
				light.updateMatrixWorld( true )
			}
		},
		dispose: () => {
			for ( const light of lights ) {
				light.removeFromParent()
				light.dispose()
			}
			lights.length = 0
		},
	}
}