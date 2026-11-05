/**
 * 城外假远景：远距圆筒天际线剪影。
 *
 * 两圈较远的内翻圆柱加地面盘，矮暗轮廓把小岛边接到雨雾里。
 * 不贴主城；窗只作稀疏冷点。不吃点光、不投影、不进高度图与倒影烤图。
 */

import {
	BackSide,
	Box3,
	CircleGeometry,
	CylinderGeometry,
	Group,
	Mesh,
	MeshBasicNodeMaterial,
	Vector3,
	type Object3D,
	type Scene,
} from 'three/webgpu'
import {
	color,
	float,
	mix,
	mx_noise_float,
	select,
	smoothstep,
	uv,
	vec2,
} from 'three/tsl'

const GROUND_COLOR = 0x070b10

/**
 * {@link createHorizonFill} 句柄。
 */
export interface HorizonFillHandle {
	/** 已加入场景的远景根节点。 */
	root: Group
	/** 从场景移除并释放几何与材质。 */
	dispose: () => void
}

/**
 * {@link createHorizonFill} 入参。
 */
export interface HorizonFillOptions {
	scene: Scene
	/** 已入场景并 updateMatrixWorld 的城根，用来量城半径。 */
	cityRoot: Object3D
}

/**
 * 圆筒天际线材质：高度噪声切屋顶，稀疏暗窗，顶部化进雾色。
 *
 * @param seed - 两圈错开的噪声种子。
 * @param density - 沿圆周的楼栋密度。
 * @param hazeAmt - 屋顶向雾色混的量，越远越大。
 */
function makeSkylineMaterial( seed: number, density: number, hazeAmt: number ): MeshBasicNodeMaterial {
	const u = uv().x
	const v = uv().y
	const heightNoise = mx_noise_float( vec2( u.mul( 11 + seed ), float( seed * 0.17 ) ), 0.5, 0.5 )
	const roof = heightNoise.mul( 0.42 ).add( 0.28 )
	const slice = u.mul( density ).fract()
	const street = slice.lessThan( 0.08 ).or( slice.greaterThan( 0.92 ) )
	const building = v.lessThan( roof ).and( street.not() )
	const cell = vec2( u.mul( 48 ), v.mul( 8 ) )
	const lit = mx_noise_float( cell.floor().add( vec2( seed, seed * 2 ) ), 0.5, 0.5 )
	const pane = cell.fract()
	const inPane = pane.x.greaterThan( 0.28 ).and( pane.x.lessThan( 0.72 ) )
		.and( pane.y.greaterThan( 0.28 ) ).and( pane.y.lessThan( 0.72 ) )
	const windowOn = building.and( inPane ).and( lit.greaterThan( 0.86 ) ).and( v.greaterThan( 0.12 ) )
	const wall = color( 0x121a26 )
	const paneLit = color( 0x1a2834 )
	const fogCol = color( 0x172a3c )
	const base = mix( wall, paneLit, select( windowOn, float( 1 ), float( 0 ) ) )
	const haze = smoothstep( float( 0.2 ), float( 0.95 ), v ).mul( hazeAmt )

	const mat = new MeshBasicNodeMaterial()
	mat.name = 'HorizonSkyline'
	mat.side = BackSide
	mat.depthWrite = true
	mat.depthTest = true
	mat.transparent = false
	mat.alphaTest = 0.5
	mat.toneMapped = false
	mat.fog = false
	mat.colorNode = mix( base, fogCol, haze )
	mat.opacityNode = select( building, float( 1 ), float( 0 ) )
	return mat
}

/**
 * 在城外铺远距矮天际线，把小岛边缘接到雾里，不贴主城。
 *
 * @param options - 场景与城根。
 * @returns 远景句柄。
 */
export function createHorizonFill( options: HorizonFillOptions ): HorizonFillHandle {
	const { scene, cityRoot } = options
	cityRoot.updateMatrixWorld( true )
	const box = new Box3().setFromObject( cityRoot )
	const center = box.getCenter( new Vector3() )
	const size = box.getSize( new Vector3() )
	const cityRadius = Math.max( 0.5 * Math.hypot( size.x, size.z ), 18 )

	const root = new Group()
	root.name = 'HorizonFill'
	root.position.set( center.x, 0, center.z )

	const ground = new Mesh(
		new CircleGeometry( cityRadius + 70, 64 ),
		new MeshBasicNodeMaterial( {
			color: GROUND_COLOR,
			toneMapped: false,
			fog: false,
		} ),
	)
	ground.name = 'HorizonGround'
	ground.rotation.x = -Math.PI / 2
	ground.position.y = -0.08
	ground.receiveShadow = false
	ground.castShadow = false
	ground.renderOrder = -8
	root.add( ground )

	const rings = [
		{ radius: cityRadius + 34, height: 11, seed: 4.2, density: 16, y: 5, haze: 0.45 },
		{ radius: cityRadius + 50, height: 13, seed: 1.7, density: 12, y: 6, haze: 0.7 },
	]
	for ( const ring of rings ) {
		const mesh = new Mesh(
			new CylinderGeometry( ring.radius, ring.radius, ring.height, 64, 1, true ),
			makeSkylineMaterial( ring.seed, ring.density, ring.haze ),
		)
		mesh.name = `HorizonSkyline_${ring.seed}`
		mesh.position.y = ring.y
		mesh.receiveShadow = false
		mesh.castShadow = false
		mesh.frustumCulled = false
		root.add( mesh )
	}

	scene.add( root )
	return {
		root,
		dispose: () => {
			root.removeFromParent()
			root.traverse( ( obj ) => {
				const mesh = obj as Mesh
				if ( mesh.isMesh !== true ) return
				mesh.geometry.dispose()
				const mat = mesh.material
				if ( Array.isArray( mat ) ) mat.forEach( ( m ) => m.dispose() )
				else mat.dispose()
			} )
		},
	}
}
