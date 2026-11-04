import { Box3, Object3D, Vector3, type Group, type Material, type Mesh } from 'three'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js'
import type { WebGPURenderer } from 'three/webgpu'

/** Basis 转码器，给 KTX2 / KHR_texture_basisu 用。 */
const BASIS_TRANSCODER_PATH = '/basis/'

/** 统一缩放后，包围盒最长边对齐到世界目标边长。 */
const DEFAULT_TARGET_SIZE = 48

/**
 * 叶卡 / 木车篷 alphaTest 裁切阈值。
 * 选 0.5：与 glTF MASK 默认 alphaCutoff 一致；BLEND→裁切后可写深度。
 */
const OCCLUSION_ALPHA_TEST = 0.5

/**
 * 红叶 / 绿叶材质硬钉名（城模 glTF）。
 * 红树 = Material_26_0；绿树 = Material_30。禁止对调。
 */
const LEAF_MATERIAL_NAMES = new Set( [ 'Material_26_0', 'Material_30' ] )

/**
 * 木车（夜市摊车）材质名。源模 alphaMode=BLEND，不写深度会透出后方栏杆。
 */
const YATAI_MATERIAL_NAMES = new Set( [ 'yatai' ] )

/** 步行导览里挡住路的柱/牌：硬钉 mesh 名，加载后直接藏。 */
const HIDDEN_MESH_NAMES = new Set( [
	'SM_shintoPillar',
	'SM_sign',
] )

/** 植物名子串：用来识别树木/草叶等，夜景里压假自发光。 */
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
 * 城模加载并归一化后的结果。
 * 城可见、等比缩小、贴地、假水隐藏；不含雨丝、真河或窗玻璃升级。
 */
export interface CityLoadResult {
	/** 已缩放并贴地、可直接入场景的城根节点。 */
	root: Group
	/** 真灯笼根节点（仅匹配 Lantern 六盏类名），供点光挂接。 */
	lanternCandidates: Object3D[]
	/** 名字含 `sm_water` 被隐藏的节点个数。 */
	hiddenWaterCount: number
	/** 实际施加的统一缩放，使最长包围边约等于 {@link CityLoadOptions.targetSize}。 */
	appliedScale: number
	/** 被压灭自发光的植物材质份数。 */
	plantEmissiveCrushed: number
	/**
	 * 叶材（Material_26_0 / Material_30）从 BLEND 改成 alphaTest 裁切并写深度的份数。
	 * 用于核对叶与前景结构遮挡是否恢复。
	 */
	plantLeafAlphaFixed: number
	/**
	 * 木车材质 yatai 从半透明混合改成实心写深度的份数。
	 * 用于核对车篷是否再透出后方栏杆。
	 */
	yataiOcclusionFixed: number
	/** 开启 receiveShadow 的 mesh 数。 */
	shadowReceiveCount: number
	/** 开启 castShadow 的 mesh 数（透明/叶跳过投影，只接影）。 */
	shadowCastCount: number
	/** 因透明或叶名跳过 castShadow 的 mesh 数。 */
	shadowCastSkipped: number
}

/**
 * {@link loadCity} 的可选参数。
 */
export interface CityLoadOptions {
	/** 已 `init()` 的 WebGPU 渲染器，供 KTX2 探测压缩格式。 */
	renderer: WebGPURenderer
	/**
	 * glTF/GLB 的绝对或站根相对 URL。
	 * @defaultValue `'/models/city.glb'`
	 */
	url?: string
	/**
	 * 缩放后包围盒最长边的目标长度（场景单位）。
	 * 源模包围盒常达千级单位，不缩小无法塞进相机。
	 * @defaultValue `48`
	 */
	targetSize?: number
	/**
	 * 为 true 时，把植物材质自发光压到 0，避免夜景假亮（树冠/绿篱）。
	 * @defaultValue `true`
	 */
	crushPlantEmissive?: boolean
}

/**
 * 加载城模（默认 `city.glb`）：挂 KTX2 / meshopt，再等比缩放、包围盒底贴到 y=0，隐藏假河水（`sm_water`），
 * 可选压草木自发光，并修叶材 / 木车遮挡深度，收集真灯笼命名节点。
 *
 * 原理：源模城尺度过大且河水是占位平面，先归一化尺寸与贴地，再藏假水，
 * 以便后续加程序积水；不改 GLB 文件本身。遮挡修补见
 * {@link fixLeafAlphaOnMesh} / {@link fixYataiOcclusionOnMesh}。
 *
 * 边界：不改写 GLB 字节；不挂灯/不下雨/不湿膜；不改雾/窗暖/帘层；
 * 植物名匹配与 threejspunk 同源启发。
 *
 * @param options - URL / 目标尺寸 / 是否压植物自发光
 * @returns 可入场景的城根与统计字段。
 */
export async function loadCity( options: CityLoadOptions ): Promise<CityLoadResult> {
	const url = options.url ?? '/models/city.glb'
	const targetSize = options.targetSize ?? DEFAULT_TARGET_SIZE
	const crushPlantEmissive = options.crushPlantEmissive ?? true

	const ktx2Loader = new KTX2Loader()
	ktx2Loader.setTranscoderPath( BASIS_TRANSCODER_PATH )
	ktx2Loader.detectSupport( options.renderer )

	const loader = new GLTFLoader()
	loader.setKTX2Loader( ktx2Loader )
	loader.setMeshoptDecoder( MeshoptDecoder )

	let root: Group
	try {
		const gltf = await loader.loadAsync( url )
		root = gltf.scene
	} finally {
		ktx2Loader.dispose()
	}

	const box = new Box3().setFromObject( root )
	const size = new Vector3()
	box.getSize( size )
	const longest = Math.max( size.x, size.y, size.z, 1e-6 )
	const appliedScale = targetSize / longest
	root.scale.setScalar( appliedScale )
	root.updateMatrixWorld( true )

	const scaledBox = new Box3().setFromObject( root )
	const min = scaledBox.min
	root.position.y -= min.y
	root.updateMatrixWorld( true )

	let hiddenWaterCount = 0
	let hiddenNamedCount = 0
	let plantEmissiveCrushed = 0
	let plantLeafAlphaFixed = 0
	let yataiOcclusionFixed = 0
	let shadowReceiveCount = 0
	let shadowCastCount = 0
	let shadowCastSkipped = 0
	const lanternCandidates: Object3D[] = []

	root.traverse( ( obj ) => {
		const name = obj.name ?? ''
		const lower = name.toLowerCase()

		if ( lower.includes( 'sm_water' ) ) {
			obj.visible = false
			hiddenWaterCount += 1
		}

		if ( HIDDEN_MESH_NAMES.has( name ) ) {
			obj.visible = false
			hiddenNamedCount += 1
		}

		// 只收真独立灯笼根（Lantern），竹枝/短册装饰不入选。
		if ( isLanternRootName( name ) ) {
			lanternCandidates.push( obj )
		}

		if ( isMesh( obj ) && looksLikePlant( name ) ) {
			if ( crushPlantEmissive ) {
				plantEmissiveCrushed += crushEmissiveOnMesh( obj )
			}
		}

		// 叶材 / 木车遮挡：须在阴影标记之前改材质，否则 transparent 判断仍按 BLEND。
		if ( isMesh( obj ) ) {
			plantLeafAlphaFixed += fixLeafAlphaOnMesh( obj )
			yataiOcclusionFixed += fixYataiOcclusionOnMesh( obj )
		}

		if ( isMesh( obj ) ) {
			// 隐藏的水占位等仍可能是 Mesh，可见性关了也别投影浪费立方体面。
			if ( ! obj.visible ) {
				obj.castShadow = false
				obj.receiveShadow = false
			} else {
				obj.receiveShadow = true
				shadowReceiveCount += 1
				const skipCast = meshLooksTransparent( obj ) || looksLikePlant( name )
				if ( skipCast ) {
					// 叶/透明：只接影不投，避免 alpha 深度写穿造成的斑驳烂影；不改材质 transparent。
					obj.castShadow = false
					shadowCastSkipped += 1
				} else {
					obj.castShadow = true
					shadowCastCount += 1
				}
			}
		}
	} )

	console.info( '[loadCity] 阴影标记', {
		shadowReceiveCount,
		shadowCastCount,
		shadowCastSkipped,
	} )
	console.info( '[loadCity] 隐藏网格', { hiddenNamedCount, names: [ ...HIDDEN_MESH_NAMES ] } )
	console.info( '[loadCity] 遮挡修补', {
		plantLeafAlphaFixed,
		yataiOcclusionFixed,
	} )

	return {
		root,
		lanternCandidates,
		hiddenWaterCount,
		appliedScale,
		plantEmissiveCrushed,
		plantLeafAlphaFixed,
		yataiOcclusionFixed,
		shadowReceiveCount,
		shadowCastCount,
		shadowCastSkipped,
	}
}

/**
 * 是否为真灯笼根节点（木灯 / 大灯 / 祭典灯），而不是装饰串。
 *
 * 硬钉事实：`bambooDecorated*`、`SM_decoration` / `SM_decoration002` 以及
 * Material_8967 叶卡是短册/绘马装饰，**不是灯**，禁止当灯笼选。
 * 真灯应挂在上述三类根上；串灯另议，不在此位冒充。
 *
 * @param name - GLB 节点名字。
 * @returns 是否为真灯笼根。
 */
function isLanternRootName( name: string ): boolean {
	return (
		/^SM_WoodenLantern\d*$/.test( name ) ||
		/^SM_bigLantern\d*$/.test( name ) ||
		/^SM_festivalLantern\d*$/.test( name )
	)
}

/**
 * Mesh 类型收窄。
 *
 * @param obj - 场景图任意节点。
 * @returns 是否为 Mesh。
 */
function isMesh( obj: Object3D ): obj is Mesh {
	return ( obj as Mesh ).isMesh === true
}


/**
 * 粗判 mesh 是否走透明/镂空：这类 mesh 投阴影容易出烂影，只接不投。
 *
 * @param mesh - 目标网格。
 * @returns 是否应按透明处理。
 */
function meshLooksTransparent( mesh: Mesh ): boolean {
	for ( const mat of normalizeMaterials( mesh.material ) ) {
		const anyMat = mat as Material & {
			transparent?: boolean
			alphaTest?: number
			opacity?: number
			transmission?: number
		}
		if ( anyMat.transparent === true ) return true
		if ( typeof anyMat.alphaTest === 'number' && anyMat.alphaTest > 0 ) return true
		if ( typeof anyMat.opacity === 'number' && anyMat.opacity < 0.99 ) return true
		if ( typeof anyMat.transmission === 'number' && anyMat.transmission > 0.01 ) return true
	}
	return false
}

/**
 * 按节点名判断是否像植物/叶子（用于 Sketchfab 夜自发光与 BLEND 叶卡处理）。
 *
 * @param name - GLB 节点名称。
 * @returns 是否植物处理对象。
 */
function looksLikePlant( name: string ): boolean {
	const lower = name.toLowerCase()
	return PLANT_NAME_HINTS.some( ( hint ) => lower.includes( hint ) )
}

/**
 * 材质名是否为硬钉叶材（红 Material_26_0 / 绿 Material_30）。
 *
 * @param name - 材质 name。
 * @returns 是否叶遮挡修补对象。
 */
function isLeafMaterialName( name: string ): boolean {
	return LEAF_MATERIAL_NAMES.has( name )
}

/**
 * 材质名是否为木车 yatai。
 *
 * @param name - 材质 name。
 * @returns 是否木车遮挡修补对象。
 */
function isYataiMaterialName( name: string ): boolean {
	return YATAI_MATERIAL_NAMES.has( name )
}

/**
 * 把红/绿叶材从 alpha BLEND 改成 alphaTest 裁切并写深度。
 *
 * 根因：城模里 Material_26_0（红叶）、Material_30（绿叶）alphaMode=BLEND；
 * GLTFLoader 会设 transparent=true 且 depthWrite=false，叶不写深度，
 * 后方栏杆/前景结构会透过来，雾景下更显穿帮。
 *
 * 做法：命中材质名则克隆后 transparent=false、depthWrite=true、
 * alphaTest=0.5（等同 MASK）。与历史上 fixPlantLeafAlpha 同路，但按材质硬钉名匹配，
 * 避免漏掉 SM_Maple* 等不含 plant 子串的节点。
 *
 * 边界：硬边裁切；不改雾/窗暖/帘/湿膜；已不透明的跳过。
 *
 * @param mesh - 任意网格（按材质名过滤）。
 * @returns 实际改动的材质份数。
 */
function fixLeafAlphaOnMesh( mesh: Mesh ): number {
	const materials = normalizeMaterials( mesh.material )
	let fixed = 0
	const next: Material[] = []

	for ( const mat of materials ) {
		const anyMat = mat as Material & {
			name?: string
			transparent?: boolean
			depthWrite?: boolean
			alphaTest?: number
			opacity?: number
			clone: () => Material
		}

		if ( ! isLeafMaterialName( anyMat.name ?? '' ) ) {
			next.push( mat )
			continue
		}

		// 只改仍走 BLEND 的叶卡；已 OPAQUE/MASK 的跳过。
		if ( anyMat.transparent !== true ) {
			next.push( mat )
			continue
		}

		const cloned = anyMat.clone() as typeof anyMat
		cloned.transparent = false
		cloned.depthWrite = true
		cloned.alphaTest = Math.max( cloned.alphaTest ?? 0, OCCLUSION_ALPHA_TEST )
		if ( typeof cloned.opacity === 'number' && cloned.opacity < 1 ) {
			cloned.opacity = 1
		}
		next.push( cloned )
		fixed += 1
	}

	if ( fixed > 0 ) {
		mesh.material = next.length === 1 ? next[ 0 ]! : next
	}
	return fixed
}

/**
 * 把木车材质 yatai 从半透明混合改成实心并写深度。
 *
 * 根因：源模 yatai alphaMode=BLEND，加载后 depthWrite=false，车篷不写深度，
 * 后方栏杆/柱会透出车身（关雾对照仍穿帮，非雾公式问题）。
 *
 * 做法：克隆后 transparent=false、depthWrite=true、opacity=1（优先实心写深，不加 alphaTest）。
 *
 * 边界：只动名为 yatai 的材质；不改叶材、窗暖、帘、雾。
 *
 * @param mesh - 任意网格（按材质名过滤）。
 * @returns 实际改动的材质份数。
 */
function fixYataiOcclusionOnMesh( mesh: Mesh ): number {
	const materials = normalizeMaterials( mesh.material )
	let fixed = 0
	const next: Material[] = []

	for ( const mat of materials ) {
		const anyMat = mat as Material & {
			name?: string
			transparent?: boolean
			depthWrite?: boolean
			alphaTest?: number
			opacity?: number
			clone: () => Material
		}

		if ( ! isYataiMaterialName( anyMat.name ?? '' ) ) {
			next.push( mat )
			continue
		}

		if ( anyMat.transparent !== true && anyMat.depthWrite !== false ) {
			next.push( mat )
			continue
		}

		const cloned = anyMat.clone() as typeof anyMat
		cloned.transparent = false
		cloned.depthWrite = true
		// 优先实心写深：不加 alphaTest，避免篷布贴图中阶 alpha 被裁出洞。
		if ( typeof cloned.opacity === 'number' && cloned.opacity < 1 ) {
			cloned.opacity = 1
		}
		next.push( cloned )
		fixed += 1
	}

	if ( fixed > 0 ) {
		mesh.material = next.length === 1 ? next[ 0 ]! : next
	}
	return fixed
}

/**
 * 压灭材质实例自发光贡献到零。
 * 先克隆再改，避免污染同材质共享的其它非植物网格。
 *
 * @param mesh - 目标网格。
 * @returns 被压灭自发光的材质份数。
 */
function crushEmissiveOnMesh( mesh: Mesh ): number {
	const materials = normalizeMaterials( mesh.material )
	let crushed = 0
	const next: Material[] = []

	for ( const mat of materials ) {
		const anyMat = mat as Material & {
			emissive?: { setRGB: ( r: number, g: number, b: number ) => void; r: number; g: number; b: number }
			emissiveIntensity?: number
			clone: () => Material
		}
		if ( ! anyMat.emissive ) {
			next.push( mat )
			continue
		}
		const lit =
			( anyMat.emissive.r + anyMat.emissive.g + anyMat.emissive.b ) > 0.01 ||
			( typeof anyMat.emissiveIntensity === 'number' && anyMat.emissiveIntensity > 0.01 )
		if ( ! lit ) {
			next.push( mat )
			continue
		}
		const cloned = anyMat.clone() as typeof anyMat
		cloned.emissive?.setRGB( 0, 0, 0 )
		if ( typeof cloned.emissiveIntensity === 'number' ) {
			cloned.emissiveIntensity = 0
		}
		next.push( cloned )
		crushed += 1
	}

	if ( crushed > 0 ) {
		mesh.material = next.length === 1 ? next[ 0 ]! : next
	}
	return crushed
}

/**
 * 把 `mesh.material` 规范成数组，便于统一遍历。
 *
 * @param material - 单材质或材质数组。
 * @returns 已拍平的列表。
 */
function normalizeMaterials( material: Material | Material[] ): Material[] {
	return Array.isArray( material ) ? material : [ material ]
}
