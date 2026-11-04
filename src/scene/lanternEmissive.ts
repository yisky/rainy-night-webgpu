/**
 * 灯笼节点与屋檐贴图灯：只改材质自发光，不创建 PointLight。
 *
 * 硬事实：木灯 / 大灯 / 祭典灯是独立节点；屋檐灯是 Material_8908 贴在
 * SM_house / SM_cakeShop / sm_houseBrewery 上（与祭典灯共享同名材质，故必须先克隆再写）。
 * 正式点光一律走 lantern-positions.json（见 lanternTableLights.ts）。
 * 边界：不改 GLB；不猜 AABB 挂灯；竹篱 / 装饰节点不是灯。
 */

import {
	Color,
	Mesh,
	Object3D,
	type Group,
	type Material,
} from 'three'

/** 屋檐自发光暖白（克隆后写入，不污染原共享材质）。 */
const EAVE_EMISSIVE_COLOR = new Color( 0xffe2c4 )

/** 屋檐自发光强度：雨夜贴图灯可辨，远看仍能成点。 */
const EAVE_EMISSIVE_INTENSITY = 1.85

/**
 * 屋檐目标建筑根名（大小写按 GLB 实际）。
 * 只在这些根下找 Material_8908 网格；祭典灯等同名材质不在此列，从而排除。
 */
const EAVE_BUILDING_ROOTS = [ 'SM_house', 'SM_cakeShop', 'sm_houseBrewery' ] as const

/**
 * {@link setupLanternEmissive} 的返回。
 */
export interface LanternEmissiveResult {
	/** 筛进灯笼分类的候选节点数。 */
	lanternCount: number
	/** 祭典灯因共享材质而克隆后写入自发光的份数。 */
	festivalCloned: number
	/** 大灯就地写入自发光的份数。 */
	bigLanternEmissivePatched: number
	/** 找到的屋檐 Material_8908 网格数（通常 3）。 */
	eaveMeshCount: number
	/** 屋檐材质克隆并加强自发光的份数。 */
	eaveEmissiveCloned: number
	/**
	 * 卸载钩子：材质挂在城景 mesh 上，随城根一起移除即可；此处为空操作，
	 * 仅与其它 setup* 的 dispose 形态对齐。
	 */
	dispose: () => void
}

/**
 * 从 GLB 灯笼候选里分类（木 / 大 / 祭典）。
 * 竹篱装饰（bambooDecorated* / SM_decoration*）不是灯，一律返回 null。
 *
 * @param name - 节点名称。
 * @returns 灯笼种类；非灯为 null。
 */
function classifyLantern( name: string ): 'wooden' | 'big' | 'festival' | null {
	if ( name.startsWith( 'SM_WoodenLantern' ) || name.toLowerCase().includes( 'woodenlantern' ) ) {
		return 'wooden'
	}
	if ( name.startsWith( 'SM_bigLantern' ) || name.toLowerCase().includes( 'biglantern' ) ) {
		return 'big'
	}
	if ( name.startsWith( 'SM_festivalLantern' ) || name.toLowerCase().includes( 'festivallantern' ) ) {
		return 'festival'
	}
	return null
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
 * 给灯笼网格写入自发光。
 *
 * @param root - 灯笼根节点。
 * @param color - 自发光 RGB。
 * @param intensity - 支持时写入的 emissiveIntensity。
 * @param cloneShared - 为 true 时先克隆再写（祭典 / 共享材质）。
 * @returns 实际改写的材质份数。
 */
function patchEmissive(
	root: Object3D,
	color: Color,
	intensity: number,
	cloneShared: boolean,
): number {
	let patched = 0
	root.traverse( ( child ) => {
		const mesh = child as Mesh
		if ( mesh.isMesh !== true ) return
		const list = Array.isArray( mesh.material ) ? mesh.material : [ mesh.material ]
		const next: Material[] = []
		for ( const mat of list ) {
			const anyMat = mat as Material & {
				emissive?: Color
				emissiveIntensity?: number
				clone: () => Material
			}
			if ( ! anyMat.emissive ) {
				next.push( mat )
				continue
			}
			const target = cloneShared ? ( anyMat.clone() as typeof anyMat ) : anyMat
			if ( ! target.emissive ) {
				next.push( mat )
				continue
			}
			target.emissive.copy( color )
			if ( typeof target.emissiveIntensity === 'number' ) {
				target.emissiveIntensity = intensity
			}
			next.push( target )
			patched += 1
		}
		if ( cloneShared ) {
			mesh.material = next.length === 1 ? next[ 0 ]! : next
		}
	} )
	return patched
}

/**
 * 已有自发光的材质乘上强度（木灯保留原发色，只抬可读性）。
 *
 * @param root - 灯笼根节点。
 * @param factor - 乘数（>1 为加强）。
 */
function bumpEmissiveIntensity( root: Object3D, factor: number ): void {
	root.traverse( ( child ) => {
		const mesh = child as Mesh
		if ( mesh.isMesh !== true ) return
		const list = Array.isArray( mesh.material ) ? mesh.material : [ mesh.material ]
		for ( const mat of list ) {
			const anyMat = mat as Material & { emissiveIntensity?: number }
			if ( typeof anyMat.emissiveIntensity === 'number' ) {
				anyMat.emissiveIntensity *= factor
			}
		}
	} )
}

/**
 * 网格是否含 Material_8908（名称含 8908 即可；GLB 实测为 `Material_8908`）。
 *
 * @param mesh - 待检网格。
 */
function meshUsesMaterial8908( mesh: Mesh ): boolean {
	const list = Array.isArray( mesh.material ) ? mesh.material : [ mesh.material ]
	return list.some( ( mat ) => ( mat?.name ?? '' ).includes( '8908' ) )
}

/**
 * 网格是否落在屋檐目标建筑根之下。
 *
 * @param mesh - 待检网格。
 */
function isUnderEaveBuilding( mesh: Object3D ): boolean {
	let p: Object3D | null = mesh
	while ( p ) {
		if ( ( EAVE_BUILDING_ROOTS as readonly string[] ).includes( p.name ) ) return true
		p = p.parent
	}
	return false
}

/**
 * 收集城根下屋檐建筑内的 Material_8908 网格（排除祭典灯）。
 *
 * @param cityRoot - 城根。
 * @returns 屋檐网格列表（按名称排序，便于结果稳定）。
 */
function collectEaveMeshes( cityRoot: Object3D ): Mesh[] {
	const found: Mesh[] = []
	cityRoot.traverse( ( obj ) => {
		if ( ! isMesh( obj ) ) return
		if ( ! meshUsesMaterial8908( obj ) ) return
		if ( ! isUnderEaveBuilding( obj ) ) return
		found.push( obj )
	} )
	found.sort( ( a, b ) => a.name.localeCompare( b.name ) )
	return found
}

/**
 * 克隆网格上的 Material_8908 并加强自发光；非目标材质不动。
 *
 * @param mesh - 屋檐网格。
 * @returns 克隆改写份数。
 */
function cloneAndBoostEaveEmissive( mesh: Mesh ): number {
	const list = Array.isArray( mesh.material ) ? mesh.material : [ mesh.material ]
	const next: Material[] = []
	let cloned = 0
	for ( const mat of list ) {
		const name = mat?.name ?? ''
		if ( ! name.includes( '8908' ) ) {
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
		const target = anyMat.clone() as typeof anyMat
		target.name = `${name}_eaveClone`
		target.emissive!.copy( EAVE_EMISSIVE_COLOR )
		if ( typeof target.emissiveIntensity === 'number' ) {
			target.emissiveIntensity = EAVE_EMISSIVE_INTENSITY
		}
		next.push( target )
		cloned += 1
	}
	if ( cloned > 0 ) {
		mesh.material = next.length === 1 ? next[ 0 ]! : next
	}
	return cloned
}

/**
 * 统一加强灯笼节点与屋檐贴图灯的材质自发光；不创建任何点光。
 *
 * 做什么：木灯抬 emissiveIntensity；大灯写暖色自发光；祭典灯克隆后写
 * （避免改坏与屋檐共享的 Material_8908）；屋檐建筑下的 8908 再克隆加强。
 * 为何：雨夜要看得见灯身/檐灯，正式照明由 lanternTableLights 读表负责。
 * 边界：不改 GLB、不挂 PointLight / Helper、不猜 AABB。
 *
 * @param lanternCandidates - {@link loadCity} 收集到的灯笼候选。
 * @param cityRoot - {@link loadCity} 返回的城根（须已入场景或可 traverse）。
 * @returns 改写统计与空 dispose。
 */
export function setupLanternEmissive(
	lanternCandidates: Object3D[],
	cityRoot: Group | Object3D,
): LanternEmissiveResult {
	const ordered = lanternCandidates
		.filter( ( c ) => classifyLantern( c.name ) !== null )
		.sort( ( a, b ) => a.name.localeCompare( b.name ) )

	let festivalCloned = 0
	let bigLanternEmissivePatched = 0

	for ( const obj of ordered ) {
		const kind = classifyLantern( obj.name )
		if ( kind === null ) continue
		if ( kind === 'big' ) {
			bigLanternEmissivePatched += patchEmissive( obj, new Color( 0xffe2c4 ), 1.25, false )
		} else if ( kind === 'festival' ) {
			festivalCloned += patchEmissive( obj, new Color( 0xffd4a8 ), 1.15, true )
		} else if ( kind === 'wooden' ) {
			bumpEmissiveIntensity( obj, 1.4 )
		}
	}

	const eaveMeshes = collectEaveMeshes( cityRoot )
	let eaveEmissiveCloned = 0
	for ( const mesh of eaveMeshes ) {
		eaveEmissiveCloned += cloneAndBoostEaveEmissive( mesh )
	}

	return {
		lanternCount: ordered.length,
		festivalCloned,
		bigLanternEmissivePatched,
		eaveMeshCount: eaveMeshes.length,
		eaveEmissiveCloned,
		dispose: () => {
			/* 材质随城根卸载；无点光可拆。 */
		},
	}
}
