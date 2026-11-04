/**
 * 雨夜窗暖自发光：只克隆改材质 emissive；不加 PointLight。
 *
 * 目标（城模约定）：
 * - `Material_27`：町屋正面窗暖主体材质；原半透明、无透射，夜景主窗。
 * - `Plane030`：唯一带 transmission 的透明窗格（按网格名匹配）。
 * 不改其它 GLB、不投影等；不影 / 雾 / 阴影 / 雨 / 灯位。
 * 灯笼见 lanternEmissive.ts；招牌贴图见 textureEmissive.ts。
 *
 * 帘/格遮挡（`Material_18`）：
 * - 源模常为 alpha BLEND，加载后不写深度；若再关 depthTest 强行后画，会无视前后关系叠乱。
 * - 改为与叶遮挡同路：alphaTest 裁切 + 恢复 depthTest/depthWrite，去掉关深度测试旁路。
 * - Material_27 仍不透明暖自发光（写深度）+ polygonOffset，减轻共面 z-fight。
 */

import {
	Color,
	Mesh,
	Object3D,
	type Group,
	type Material,
} from 'three'

/**
 * 窗暖自发光色：暖白偏桃，远看仍像灯，近处不脏黄。
 */
const WINDOW_EMISSIVE_COLOR = new Color( 0xffd4a8 )

/**
 * Material_27 目标 emissiveIntensity。
 * 略抬，让外景缩成像素时还能被泛光咬到。
 */
const MATERIAL_27_INTENSITY = 2.7

/**
 * Plane030 目标 emissiveIntensity：带透射，略低于主体以免过曝。
 */
const PLANE030_INTENSITY = 1.85

/**
 * Material_27（窗暖主体）的 renderOrder：先于其它叠层，先画。
 */
const WINDOW_GLASS_RENDER_ORDER = 1

/**
 * 帘/格 Material_18 的 alpha 裁切阈值。
 * 选 0.5：与 glTF MASK 默认 alphaCutoff、以及叶遮挡 OCCLUSION_ALPHA_TEST 一致。
 */
const CURTAIN_ALPHA_TEST = 0.5

/**
 * 按材质名命中的窗暖主体；精确匹配；克隆后带后缀仍可按原名前缀认。
 */
const WINDOW_MATERIAL_NAMES = new Set( [ 'Material_27' ] )

/**
 * 帘/格遮挡材质名：贴在 Material_27 窗外缘；只改深度/裁切，不动 emissive。
 */
const WINDOW_CURTAIN_MATERIAL_NAMES = new Set( [ 'Material_18' ] )

/**
 * 按网格名前缀命中的透射窗（GLB 节点名、不是材质名）。
 */
const WINDOW_MESH_NAME_PREFIXES = [ 'Plane030' ] as const

/**
 * {@link setupWindowEmissive} 的返回。
 */
export interface WindowEmissiveResult {
	/** 实际克隆并改写的材质份数。 */
	patchedCount: number
	/** 按键汇总（材质名或 mesh:网格名）。 */
	byKey: Record<string, number>
	/** 被改写过的网格（供事后看机位对准）。 */
	patchedMeshes: Mesh[]
	/**
	 * 帘/格遮挡处理份数：Material_18 改为 alphaTest 裁切并写深度
	 * （不再关 depthTest 强行后画；未动 emissive）。
	 */
	curtainOrderCount: number
	dispose: () => void
}

/**
 * 遍历城根：给 Material_27 / Plane030 克隆写暖色自发光，夜景店铺窗可辨；
 * 给 Material_18（帘/格）改 alpha 裁切并恢复深度读写，纠正叠层穿帮。
 *
 * 为什么只限这两类窗：窗口可发光。Material_27 原半透；Plane030 有 transmission
 * 却缺暖感。只做运行时自发光，不加灯、不改源资产。
 *
 * 帘/格：去掉 depthTest=false 旁路；与叶遮挡同路用 alphaTest + depthWrite，
 * 让场景深度图无洞，雾与前方遮挡按正确深度算。
 *
 * @param cityRoot - {@link loadCity} 返回的城根
 * @returns 改写统计、网格列表与 dispose（材质跟网格走，无额外句柄）
 */
export function setupWindowEmissive( cityRoot: Group | Object3D ): WindowEmissiveResult {
	const byKey: Record<string, number> = {}
	const patchedMeshes: Mesh[] = []
	let patchedCount = 0
	let curtainOrderCount = 0

	cityRoot.traverse( ( obj ) => {
		if ( ! isMesh( obj ) ) return

		const list = Array.isArray( obj.material ) ? obj.material : [ obj.material ]
		const next: Material[] = []
		let changed = false
		const meshIsPlane030 = meshNameMatchesWindow( obj.name )
		let hitGlass = false

		for ( const mat of list ) {
			const matName = mat?.name ?? ''

			// —— 帘/格 Material_18：alpha 裁切 + 写深度（对齐叶遮挡）——
			const hitCurtainMat =
				WINDOW_CURTAIN_MATERIAL_NAMES.has( matName ) ||
				[ ...WINDOW_CURTAIN_MATERIAL_NAMES ].some( ( n ) => matName.startsWith( `${n}_` ) )
			if ( hitCurtainMat ) {
				const curtainMat = mat as Material & {
					transparent?: boolean
					depthWrite?: boolean
					depthTest?: boolean
					alphaTest?: number
					opacity?: number
					clone: () => Material
				}
				const cloned = curtainMat.clone() as typeof curtainMat
				cloned.name = `${matName || obj.name}_curtainOcclusionClone`
				// 去掉关 depthTest 强行后画：恢复深度测试与写深，避免无视前后叠乱。
				cloned.depthTest = true
				cloned.depthWrite = true
				// 半透 BLEND → 裁切：透明度低于阈值的像素丢弃，其余当实心写深。
				cloned.transparent = false
				cloned.alphaTest = Math.max( cloned.alphaTest ?? 0, CURTAIN_ALPHA_TEST )
				if ( typeof cloned.opacity === 'number' && cloned.opacity < 1 ) {
					cloned.opacity = 1
				}
				next.push( cloned )
				changed = true
				curtainOrderCount += 1
				continue
			}

			// —— 窗暖主体 Material_27 / Plane030 ——
			const hitByMat =
				WINDOW_MATERIAL_NAMES.has( matName ) ||
				[ ...WINDOW_MATERIAL_NAMES ].some( ( n ) => matName.startsWith( `${n}_` ) )
			if ( ! hitByMat && ! meshIsPlane030 ) {
				next.push( mat )
				continue
			}

			const anyMat = mat as Material & {
				emissive?: Color
				emissiveIntensity?: number
				transparent?: boolean
				opacity?: number
				depthWrite?: boolean
				polygonOffset?: boolean
				polygonOffsetFactor?: number
				polygonOffsetUnits?: number
				clone: () => Material
			}
			if ( ! anyMat.emissive ) {
				next.push( mat )
				continue
			}

			const cloned = anyMat.clone() as typeof anyMat
			const key = hitByMat ? 'Material_27' : `mesh:${obj.name}`
			cloned.name = `${matName || obj.name}_windowNightClone`
			cloned.emissive!.copy( WINDOW_EMISSIVE_COLOR )

			if ( typeof cloned.emissiveIntensity === 'number' ) {
				cloned.emissiveIntensity = hitByMat
					? MATERIAL_27_INTENSITY
					: PLANE030_INTENSITY
			}

			// Material_27：只开暖自发光，保持不透明 + depthWrite。
			// 曾试半透+depthWrite=false，WebGPU 下低机位会洗平；现不透明稳画面。
			// polygonOffset 减轻与远共面 z-fight。
			if ( hitByMat ) {
				cloned.transparent = false
				if ( typeof cloned.opacity === 'number' ) {
					cloned.opacity = 1
				}
				cloned.depthWrite = true
				cloned.polygonOffset = true
				cloned.polygonOffsetFactor = 1
				cloned.polygonOffsetUnits = 1
				hitGlass = true
			}

			next.push( cloned )
			changed = true
			patchedCount += 1
			byKey[ key ] = ( byKey[ key ] ?? 0 ) + 1
		}

		if ( changed ) {
			obj.material = next.length === 1 ? next[ 0 ]! : next
			patchedMeshes.push( obj )
		}

		// 窗暖主体先画；帘/格靠深度缓冲自洽，不再抬 renderOrder / 关 depthTest。
		if ( hitGlass ) {
			obj.renderOrder = WINDOW_GLASS_RENDER_ORDER
		}
	} )

	console.info(
		'[windowEmissive] 窗暖自发光 ' +
			JSON.stringify( { patchedCount, byKey, curtainOrderCount } ),
	)

	return {
		patchedCount,
		byKey,
		patchedMeshes,
		curtainOrderCount,
		dispose: () => {
			// 克隆材质跟网格走；城根移除即可，无额外句柄。
		},
	}
}

/**
 * Mesh 类型收窄。
 *
 * @param obj - 场景节点。
 */
function isMesh( obj: Object3D ): obj is Mesh {
	return ( obj as Mesh ).isMesh === true
}

/**
 * 网格名是否命中透射窗前缀（如 Plane030 / Plane030__0）。
 *
 * @param name - 网格名。
 */
function meshNameMatchesWindow( name: string ): boolean {
	return WINDOW_MESH_NAME_PREFIXES.some(
		( prefix ) =>
			name === prefix ||
			name.startsWith( `${prefix}_` ) ||
			name.startsWith( `${prefix}.` ),
	)
}