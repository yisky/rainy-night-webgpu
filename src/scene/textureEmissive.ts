/**
 * 场景其它贴图灯/招牌自发光增强：只克隆调 emissive，不堆点光。
 *
 * 目标材质（GLB 审计）：店铺已有非零自发光的 Material_21 / Material_94。
 * 明确不做：短册 Material_8967；草木可疑自发光（由 loadCity 压掉，此处再跳过）。
 * 边界：不改 GLB；不给这些材质加 PointLight；屋檐 8908 由 lanternEmissive.ts 专管。
 */

import {
	Color,
	Mesh,
	Object3D,
	type Group,
	type Material,
} from 'three'

/**
 * 店铺贴图灯：按材质名匹配，克隆后写入暖色自发光与强度。
 * 强度按原 emissive 亮度分级，弱的抬得多一点，已很亮的只暖化并略增。
 */
const SHOP_EMISSIVE_TARGETS: {
	/** 材质名完整匹配（GLB 导出名为 Material_N）。 */
	name: string
	/** 目标自发光色。 */
	color: number
	/** 目标 emissiveIntensity。 */
	intensity: number
}[] = [
	{ name: 'Material_21', color: 0xffe0c8, intensity: 1.85 },
	{ name: 'Material_94', color: 0xffd4b0, intensity: 1.8 },
]

/** 禁止当灯加亮的材质名（七夕短册）。 */
const FORBIDDEN_MATERIAL_NAMES = new Set( [ 'Material_8967' ] )

/** 名称像草木时跳过（双保险；主压制在 loadCity）。 */
const PLANT_NAME_HINTS = [
	'hedge',
	'bamboo',
	'tree',
	'plant',
	'foliage',
	'bush',
	'grass',
	'ivy',
	'leave',
] as const

/**
 * {@link setupTextureEmissive} 结果。
 */
export interface TextureEmissiveResult {
	/** 实际克隆并改写的材质份数。 */
	patchedCount: number
	/** 命中的材质名 → 份数。 */
	byMaterial: Record<string, number>
	dispose: () => void
}

/**
 * 遍历城根：对店铺贴图灯材质克隆并加强自发光，使雨夜招牌/门窗可读。
 *
 * 原理：这些材质在 GLB 里已有非零 emissive，但按晴日烘焙偏弱；
 * 夜景压光后几乎看不见，故运行时克隆抬亮。只做贴图自发光，不挂点光。
 *
 * @param cityRoot - {@link loadCity} 返回的城根。
 * @returns 改写统计与空 dispose（材质跟网格走，卸城时一并丢）。
 */
export function setupTextureEmissive( cityRoot: Group | Object3D ): TextureEmissiveResult {
	const targetByName = new Map( SHOP_EMISSIVE_TARGETS.map( ( t ) => [ t.name, t ] ) )
	const byMaterial: Record<string, number> = {}
	let patchedCount = 0

	cityRoot.traverse( ( obj ) => {
		if ( ! isMesh( obj ) ) return
		if ( looksLikePlant( obj.name ) ) return

		const list = Array.isArray( obj.material ) ? obj.material : [ obj.material ]
		const next: Material[] = []
		let changed = false

		for ( const mat of list ) {
			const matName = mat?.name ?? ''
			if ( FORBIDDEN_MATERIAL_NAMES.has( matName ) ) {
				next.push( mat )
				continue
			}
			const spec = targetByName.get( matName )
			if ( ! spec ) {
				next.push( mat )
				continue
			}

			const anyMat = mat as Material & {
				emissive?: Color
				emissiveIntensity?: number
				clone: () => Material
			}
			if ( ! anyMat.emissive ) {
				next.push( mat )
				continue
			}

			const cloned = anyMat.clone() as typeof anyMat
			cloned.name = `${matName}_nightClone`
			cloned.emissive!.set( spec.color )
			if ( typeof cloned.emissiveIntensity === 'number' ) {
				cloned.emissiveIntensity = spec.intensity
			}
			next.push( cloned )
			changed = true
			patchedCount += 1
			byMaterial[ matName ] = ( byMaterial[ matName ] ?? 0 ) + 1
		}

		if ( changed ) {
			obj.material = next.length === 1 ? next[ 0 ]! : next
		}
	} )

	return {
		patchedCount,
		byMaterial,
		dispose: () => {
			// 克隆材质挂在网格上，随城根从场景移除即可；无独立 GPU 光资源可释。
		},
	}
}

/**
 * Mesh 类型守卫。
 *
 * @param obj - 场景节点。
 */
function isMesh( obj: Object3D ): obj is Mesh {
	return ( obj as Mesh ).isMesh === true
}

/**
 * 名称是否像草木（跳过，避免脏画面）。
 *
 * @param name - 物体名。
 */
function looksLikePlant( name: string ): boolean {
	const lower = name.toLowerCase()
	return PLANT_NAME_HINTS.some( ( hint ) => lower.includes( hint ) )
}
