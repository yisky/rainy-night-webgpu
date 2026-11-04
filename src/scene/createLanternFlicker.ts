/**
 * 灯笼微闪：纸灯点光与独立灯笼自发光同相位轻抖，串灯更弱、更慢。
 *
 * 只改 intensity / emissiveIntensity；不改色温、衰减、位置，不重烘阴影。
 * 窗暖、招牌、屋檐 Material_8908 贴图灯不进此系统。
 * 共享自发光材质会先克隆，避免三盏木灯绑死成同一呼吸。
 *
 * 性能：建时收集槽位；每帧 23 盏点光各两次 sin + 若干材质 float 写。
 * ClusteredLighting 本就会上传灯数据；阴影 autoUpdate 仍关。
 * 倒影烤图仍按相机跳过——振幅约 ±7%，静帧里陈旧倒影看不出。
 */

import {
	type Color,
	type Material,
	type Mesh,
	type Object3D,
	type PointLight,
} from 'three'

/** {@link setupLanternTableLights} 写在 `light.userData` 上的微闪元数据键。 */
export const LANTERN_FLICKER_USERDATA_KEY = 'rainyLanternFlicker'

/**
 * 点光建灯时挂上的微闪元数据。
 */
export interface LanternFlickerLightMeta {
	/** 建灯时的强度，微闪相对此值乘算，禁止用当前 intensity 当基底以免漂移。 */
	base: number
	/** 独立真灯笼（木/大/祭典）为 true；屋檐/烤串 merged 为 false。 */
	independent: boolean
	/** 与城模灯笼根名对齐的键；merged 也写表 name，仅作相位种子。 */
	key: string
}

/**
 * {@link createLanternFlicker} 入参。
 */
export interface LanternFlickerOptions {
	/** 灯位表点光（须已写入 {@link LANTERN_FLICKER_USERDATA_KEY}）。 */
	lights: PointLight[]
	/** 独立灯笼根（loadCity 的 lanternCandidates），用来同步纸面自发光。 */
	lanternRoots: Object3D[]
}

/**
 * 微闪句柄。
 */
export interface LanternFlickerHandle {
	/**
	 * 用墙钟秒更新强度。用绝对时间而不是累加 dt，切后台回来相位连续。
	 *
	 * @param timeSec - `performance.now() * 0.001`
	 */
	update: ( timeSec: number ) => void
	/** 把强度写回基底；不拆材质（仍挂在城模上）。 */
	dispose: () => void
}

/** 独立纸灯：可见的烛火抖动。 */
const INDEPENDENT_AMP = 0.07
/** 串灯 / 屋檐点光：电灯微漂，避免整串一起呼吸。 */
const MERGED_AMP = 0.022
/** 慢波频率范围（Hz）。 */
const SLOW_HZ = [ 0.32, 0.75 ] as const
/** 快波频率范围（Hz）。独立灯略加点烛火碎抖。 */
const FAST_HZ = [ 1.8, 3.4 ] as const
/** 快波在独立灯里的权重。 */
const FAST_MIX_INDEPENDENT = 0.32
/** 快波在串灯里几乎关掉，只留慢漂。 */
const FAST_MIX_MERGED = 0.08

interface LightSlot {
	light: PointLight
	base: number
	amp: number
	slowW: number
	fastW: number
	slowP: number
	fastP: number
	fastMix: number
}

type EmissiveMat = Material & {
	emissive?: Color
	emissiveIntensity?: number
	clone: () => Material
}

interface EmissiveSlot {
	mat: EmissiveMat
	base: number
	lightIndex: number
}

/**
 * FNV-1a 把字符串收成 [0,1)。相位种子，不要每帧 random。
 *
 * @param text - 灯名或加点缀的种子。
 */
function hash01( text: string ): number {
	let h = 2166136261
	for ( let i = 0; i < text.length; i++ ) {
		h ^= text.charCodeAt( i )
		h = Math.imul( h, 16777619 )
	}
	return ( h >>> 0 ) / 4294967296
}

/**
 * 材质是否有看得见的自发光（黑底 + 默认 intensity 不算）。
 *
 * @param mat - 网格材质。
 */
function hasVisibleEmissive( mat: Material ): mat is EmissiveMat {
	const m = mat as EmissiveMat
	const emissive = m.emissive
	if ( ! emissive || typeof m.emissiveIntensity !== 'number' ) return false
	if ( m.emissiveIntensity <= 0 ) return false
	return emissive.r + emissive.g + emissive.b > 1e-4
}

function isMesh( obj: Object3D ): obj is Mesh {
	return ( obj as Mesh ).isMesh === true
}

/**
 * 读点光上的微闪元数据。
 *
 * @param light - 灯位表点光。
 */
function readMeta( light: PointLight ): LanternFlickerLightMeta | null {
	const meta = light.userData[ LANTERN_FLICKER_USERDATA_KEY ] as LanternFlickerLightMeta | undefined
	if ( ! meta || typeof meta.base !== 'number' || typeof meta.key !== 'string' ) {
		return null
	}
	return meta
}

/**
 * 按独立灯笼根收集自发光槽；已被别的灯占用的材质先克隆再写。
 *
 * @param root - 独立灯笼根节点。
 * @param claimed - 已经归属某盏灯的材质。
 */
function collectEmissiveSlots( root: Object3D, claimed: Set<Material> ): Omit<EmissiveSlot, 'lightIndex'>[] {
	const slots: Omit<EmissiveSlot, 'lightIndex'>[] = []
	root.traverse( ( child ) => {
		if ( ! isMesh( child ) ) return
		const list = Array.isArray( child.material ) ? child.material : [ child.material ]
		const next: Material[] = []
		let changed = false
		for ( const mat of list ) {
			if ( ! hasVisibleEmissive( mat ) ) {
				next.push( mat )
				continue
			}
			let target: EmissiveMat = mat
			if ( claimed.has( mat ) ) {
				target = mat.clone() as EmissiveMat
				changed = true
			}
			claimed.add( target )
			next.push( target )
			slots.push( {
				mat: target,
				base: target.emissiveIntensity ?? 1,
			} )
		}
		if ( changed ) {
			child.material = next.length === 1 ? next[ 0 ]! : next
		}
	} )
	return slots
}

/**
 * 搭建灯笼微闪：点光全员；自发光只跟独立真灯笼。
 *
 * @param options - 点光与灯笼根。
 */
export function createLanternFlicker( options: LanternFlickerOptions ): LanternFlickerHandle {
	const { lights, lanternRoots } = options
	const lightSlots: LightSlot[] = []
	const keyToLightIndex = new Map<string, number>()
	const twoPi = Math.PI * 2

	for ( let i = 0; i < lights.length; i++ ) {
		const light = lights[ i ]!
		const meta = readMeta( light )
		const independent = meta?.independent === true
		const key = meta?.key ?? light.name
		const base = meta?.base ?? light.intensity
		const hSlow = hash01( key )
		const hFast = hash01( `${key}#fast` )
		lightSlots.push( {
			light,
			base,
			amp: independent ? INDEPENDENT_AMP : MERGED_AMP,
			slowW: twoPi * ( SLOW_HZ[ 0 ] + hSlow * ( SLOW_HZ[ 1 ] - SLOW_HZ[ 0 ] ) ),
			fastW: twoPi * ( FAST_HZ[ 0 ] + hFast * ( FAST_HZ[ 1 ] - FAST_HZ[ 0 ] ) ),
			slowP: hSlow * twoPi,
			fastP: hFast * twoPi,
			fastMix: independent ? FAST_MIX_INDEPENDENT : FAST_MIX_MERGED,
		} )
		if ( independent && ! keyToLightIndex.has( key ) ) {
			keyToLightIndex.set( key, i )
		}
	}

	const factors = new Float64Array( lightSlots.length )
	const emissiveSlots: EmissiveSlot[] = []
	const claimed = new Set<Material>()
	const rootsByName = new Map<string, Object3D>()
	for ( const root of lanternRoots ) {
		if ( root.name && ! rootsByName.has( root.name ) ) {
			rootsByName.set( root.name, root )
		}
	}
	for ( const [ key, lightIndex ] of keyToLightIndex ) {
		const root = rootsByName.get( key )
		if ( ! root ) continue
		for ( const slot of collectEmissiveSlots( root, claimed ) ) {
			emissiveSlots.push( {
				mat: slot.mat,
				base: slot.base,
				lightIndex,
			} )
		}
	}

	return {
		update: ( timeSec: number ) => {
			for ( let i = 0; i < lightSlots.length; i++ ) {
				const slot = lightSlots[ i ]!
				const slow = Math.sin( timeSec * slot.slowW + slot.slowP )
				const fast = Math.sin( timeSec * slot.fastW + slot.fastP )
				const wave = slow * ( 1 - slot.fastMix ) + fast * slot.fastMix
				const factor = 1 + slot.amp * wave
				factors[ i ] = factor
				slot.light.intensity = slot.base * factor
			}
			for ( let i = 0; i < emissiveSlots.length; i++ ) {
				const slot = emissiveSlots[ i ]!
				slot.mat.emissiveIntensity = slot.base * factors[ slot.lightIndex ]!
			}
		},
		dispose: () => {
			for ( const slot of lightSlots ) {
				slot.light.intensity = slot.base
			}
			for ( const slot of emissiveSlots ) {
				slot.mat.emissiveIntensity = slot.base
			}
			lightSlots.length = 0
			emissiveSlots.length = 0
			claimed.clear()
		},
	}
}
