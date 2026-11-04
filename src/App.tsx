import { useEffect, useRef } from 'react'
import { NoToneMapping, PCFShadowMap, PerspectiveCamera, Scene } from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { ClusteredLighting } from 'three/addons/lighting/ClusteredLighting.js'
import { WebGPURenderer } from 'three/webgpu'
import { createNightAmbient } from './atmosphere/createNightAmbient'
import { createPostPipeline } from './atmosphere/createPostPipeline'
import { createNightSky } from './atmosphere/createNightSky'
import { createHorizonFill } from './atmosphere/createHorizonFill'
import { createRoadBridgeWet } from './ground/createRoadBridgeWet'
import { createPlanarPuddleReflect } from './ground/createPlanarPuddleReflect'
import { createCanalWater } from './water/createCanalWater'
import { createHeightMap } from './rain/createHeightMap'
import { createRain } from './rain/createRain'
import { createRainAudio } from './audio/createRainAudio'
import { createLightning } from './lightning/createLightning'
import { createLanternFlicker } from './scene/createLanternFlicker'
import { setupLanternEmissive } from './scene/lanternEmissive'
import { setupLanternTableLights } from './scene/lanternTableLights'
import { loadCity } from './scene/loadCity'
import { setupTextureEmissive } from './scene/textureEmissive'
import { setupWindowEmissive } from './scene/windowEmissive'
import { createSceneTour } from './tour/createSceneTour'
import { createFps } from './ui/fps'

/**
 * 雨夜主入口（编排器）：加载城景与夜空，装底光与后处理管线，
 * 再挂灯位 / 自发光 / 雨 / 湿膜；帧末 `pipeline.render()` 出画。
 *
 * 帧序：控件 → 灯笼微闪 / 闪电 / 雨雷声 → 高度图（隔帧）→ 雨 → 湿膜/河面 → 河面烤图 → 一台路面烤图（两组轮转）→ 管线渲染。
 * 边界：城内灯笼节点 / 强度色温写在灯位表；雾色只进 SSF，不改背景。
 *
 * @returns 全屏画布的 React 节点；左上角帧率浮层挂在 `document.body`。
 */
export default function App() {
	const hostRef = useRef<HTMLDivElement | null>( null )

	useEffect( () => {
		const maybeHost = hostRef.current
		if ( maybeHost === null ) return
		const hostEl: HTMLDivElement = maybeHost

		let disposed = false
		let renderer: WebGPURenderer | undefined
		let frame = 0
		let controls: OrbitControls | undefined
		let cleanupExtras: () => void = () => {}
		const fps = createFps()
		const weatherAudio = createRainAudio()

		/**
		 * 异步启动：渲染器 → 城 / 夜空 → 底光 → 后处理管线 → 灯 / 雨 / 湿膜 → 循环。
		 *
		 * @returns 内部清理函数（取消 rAF、卸载监听、释放 GPU 资源等）
		 */
		async function boot(): Promise<() => void> {
			// —— 1. 渲染器 ——
			renderer = new WebGPURenderer( {
				antialias: true,
				// 6 盏立方体阴影 + 材质贴图仍可能顶到默认 16 张采样贴图以上。
				// 本机适配器支持 48，建 device 时显式抬高；maxSamplers 硬顶 16，勿改。
				requiredLimits: {
					maxSampledTexturesPerShaderStage: 48,
				},
			} )
			// 无阴影点光走 Forward+ cluster；带阴影的 6 盏仍走传统材质灯。
			renderer.lighting = new ClusteredLighting( 32, 32, 24, 24 )
			await renderer.init()
			console.info( '[rainy-night] renderer backend', {
				isWebGPUBackend: Boolean( ( renderer as { backend?: { isWebGPUBackend?: boolean } } ).backend?.isWebGPUBackend ),
			} )
			if ( disposed ) {
				renderer.dispose()
				return () => {}
			}

			renderer.setPixelRatio( Math.min( window.devicePixelRatio, 2 ) )
			renderer.setSize( hostEl.clientWidth, hostEl.clientHeight )
			renderer.setClearColor( 0x101820, 1 )
			// 渲染器保持线性，倒影烤图才不会被 ACES 压两遍。
			// 主画面色调映射走管线里的 renderOutput(ACES)，曝光用这一项。
			renderer.toneMapping = NoToneMapping
			renderer.toneMappingExposure = 1.2
			renderer.shadowMap.enabled = true
			renderer.shadowMap.type = PCFShadowMap
			// 自管 rAF，不走 setAnimationLoop；帧计数自己 reset，否则 drawCalls 会累加。
			renderer.info.autoReset = false
			hostEl.appendChild( renderer.domElement )

			// —— 2. 场景 / 相机 / 轨道 ——
			const scene = new Scene()
			const camera = new PerspectiveCamera(
				45,
				hostEl.clientWidth / Math.max( hostEl.clientHeight, 1 ),
				0.1,
				400,
			)
			camera.position.set( 45.343, 21.692, 38.276 )
			controls = new OrbitControls( camera, renderer.domElement )
			controls.enableDamping = false
			controls.target.set( 1.926, 5.597, -4.203 )
			controls.maxPolarAngle = Math.PI * 0.49
			controls.minDistance = 4
			controls.maxDistance = 120
			controls.update()

			// —— 3. 城模 ——
			const city = await loadCity( { renderer } )
			if ( disposed ) {
				return () => {}
			}
			scene.add( city.root )
			city.root.updateMatrixWorld( true )

			// —— 4. 夜空 / 底光 / 后处理管线 ——
			const sky = await createNightSky( { scene, renderer, camera } )
			const horizon = createHorizonFill( { scene, cityRoot: city.root } )
			const nightAmbient = createNightAmbient( scene )
			const post = createPostPipeline( { renderer, scene, camera } )
			const lightning = createLightning( { scene, camera } )
			weatherAudio.setAutoThunder( false )

			// —— 5. 自发光与灯位表（正式点光） ——
			const lanternGlow = setupLanternEmissive( city.lanternCandidates, city.root )
			const tableLights = await setupLanternTableLights( scene, city.root, {
				enableShadows: true,
				appliedScale: city.appliedScale,
			} )
			const shopGlow = setupTextureEmissive( city.root )
			const windowGlow = setupWindowEmissive( city.root )
			const lanternFlicker = createLanternFlicker( {
				lights: tableLights.lights,
				lanternRoots: city.lanternCandidates,
			} )

			// —— 6. 高度图 / 雨 / 路桥湿膜 ——
			const heightMap = createHeightMap( { scene, renderer } )
			const rain = await createRain( {
				scene,
				renderer,
				heightMap,
				camera,
			} )
			if ( disposed ) {
				rain.dispose()
				heightMap.dispose()
				lightning.dispose()
				horizon.dispose()
				return () => {}
			}
			const roadWet = await createRoadBridgeWet( { scene, cityRoot: city.root } )
			const roadCluster0 = roadWet.clusters[ 0 ]!
			const roadCluster1 = roadWet.clusters[ 1 ]!
			const planarReflect0 = createPlanarPuddleReflect( {
				scene,
				planeY: roadCluster0.planeY,
				aspect: camera.aspect,
				resolution: 512,
				strength: 2.5,
				includeSky: true,
				mirrorFar: 40,
				bakeEmissiveGain: 6,
				generateMipmaps: true,
			} )
			const planarReflect1 = createPlanarPuddleReflect( {
				scene,
				planeY: roadCluster1.planeY,
				aspect: camera.aspect,
				resolution: 384,
				strength: 2.5,
				includeSky: true,
				mirrorFar: 40,
				bakeEmissiveGain: 6,
				generateMipmaps: true,
			} )
			roadWet.attachPlanarReflect( [
				{ sampleNode: planarReflect0.sampleNode, uTextureMatrix: planarReflect0.uTextureMatrix, planeY: roadCluster0.planeY },
				{ sampleNode: planarReflect1.sampleNode, uTextureMatrix: planarReflect1.uTextureMatrix, planeY: roadCluster1.planeY },
			], heightMap )
			// —— 真河道：克隆 sm_water 几何；河面单独半分辨率平面烤图 ——
			const canalWater = createCanalWater( { scene, cityRoot: city.root } )
			const canalReflect = createPlanarPuddleReflect( {
				scene,
				planeY: canalWater.planeY,
				aspect: camera.aspect,
				resolution: 512,
				// 菲涅尔接管掠射/俯视强度，strength 为总增益（Additive × F × strength）
				strength: 2.5,
				includeSky: true,
				// 运河烤图只留近岸对象；道路湿膜不传此模式
				bakeMode: 'canalBanks',
				bankMaxDistance: 18,
				bankReferenceObjects: canalWater.meshes,
				bankFlowDir: canalWater.flowDir,
				// 镜面 far 单独缩短，勿改主相机 far
				mirrorFar: 60,
				bakeEmissiveGain: 6,
				// 河面整块镜子：跳过阈值须紧，否则转角后投影对不齐。
				skipPosEps: 1e-4,
				skipQuatEps: 1e-5,
			} )
			canalWater.attachPlanarReflect( canalReflect.sampleNode, canalReflect.uStrength, canalReflect.uTextureMatrix )
			if ( disposed ) {
				canalReflect.dispose()
				canalWater.dispose()
				planarReflect1.dispose()
				planarReflect0.dispose()
				roadWet.dispose()
				rain.dispose()
				heightMap.dispose()
				lightning.dispose()
				horizon.dispose()
				return () => {}
			}

			// 城模 / 点光 / 湿膜都挂好后再烘阴影；灯位静态，矩阵只更这一次。
			tableLights.update()
			tableLights.requestShadowUpdate()

			const onResize = () => {
				const w = hostEl.clientWidth
				const h = Math.max( hostEl.clientHeight, 1 )
				camera.aspect = w / h
				camera.updateProjectionMatrix()
				renderer!.setSize( w, h )
				post.resize( w, h )
				canalReflect.forceNextBake()
				planarReflect0.forceNextBake()
				planarReflect1.forceNextBake()
			}
			window.addEventListener( 'resize', onResize )
			onResize()

			let lastMs = performance.now()
			const heightHide = [ rain.root, sky.mesh, horizon.root, lightning.root, ...roadWet.reflectOverlays ]
			const reflectHide = [ ...roadWet.reflectOverlays, ...canalWater.reflectMeshes ]
			const hideObjects = [
				...roadWet.overlays,
				...reflectHide,
				...canalWater.meshes,
				rain.root,
				horizon.root,
			]
			const roadVis0 = roadWet.getClusterReflectOverlays( 0 )
			const roadVis1 = roadWet.getClusterReflectOverlays( 1 )
			const roadBakes = [
				{
					reflect: planarReflect0,
					visibilityMeshes: roadVis0,
				},
				{
					reflect: planarReflect1,
					visibilityMeshes: roadVis1,
				},
			] as const
			let roadBakeTurn = 0
			const tour = createSceneTour( {
				camera,
				controls,
				cityRoot: city.root,
				canalY: canalWater.planeY,
				onCue: ( name ) => {
					if ( name === 'lightning' ) {
						lightning.strikeNow( camera, performance.now() * 0.001 )
					}
				},
			} )
			const tick = () => {
				frame = requestAnimationFrame( tick )
				if ( disposed ) return
				const now = performance.now()
				const dt = Math.min( 0.05, ( now - lastMs ) / 1000 )
				lastMs = now
				renderer!.info.reset()

				if ( tour.playing ) tour.update( dt )
				else controls?.update()
				// 微闪须在倒影烤图之前，强度才进镜子；不触发阴影重烘。
				lanternFlicker.update( now * 0.001 )
				const flash = lightning.update( now * 0.001, camera )
				post.setLightningFill( flash.fill )
				if ( flash.forceBake ) {
					canalReflect.forceNextBake()
				}
				if ( flash.thunderDelay !== null ) {
					weatherAudio.playThunderClip( flash.thunderDelay )
				}
				weatherAudio.update( now * 0.001 )

				// 高度图须在雨之前；排除天穹（hide + 天穹不在第 0 层）和倒影叠层（叠层采高度图）。
				heightMap.update( {
					camera,
					hideObjects: heightHide,
				} )
				rain.update( dt, camera )
				roadWet.update( dt )
				canalWater.update( dt )
				// 河面每帧烤（整块镜子，错帧会丢倒影）；路面两组错帧。
				canalReflect.update( {
					renderer: renderer!,
					camera,
					hideObjects,
				} )
				const roadBake = roadBakes[ roadBakeTurn ]!
				roadBakeTurn = ( roadBakeTurn + 1 ) % roadBakes.length
				roadBake.reflect.update( {
					renderer: renderer!,
					camera,
					hideObjects,
					visibilityMeshes: roadBake.visibilityMeshes,
					visibilityMaxDistance: 35,
				} )
				post.render()
				fps.frame( dt * 1000, renderer!.info.render.drawCalls )
			}
			tick()

			let cleaned = false
			const cleanup = () => {
				if ( cleaned ) return
				cleaned = true
				cancelAnimationFrame( frame )
				window.removeEventListener( 'resize', onResize )
				// 业务先拆，后处理后建先拆
				canalReflect.dispose()
				canalWater.dispose()
				planarReflect1.dispose()
				planarReflect0.dispose()
				roadWet.dispose()
				rain.dispose()
				heightMap.dispose()
				shopGlow.dispose()
				windowGlow.dispose()
				lanternFlicker.dispose()
				lightning.dispose()
				tableLights.dispose()
				lanternGlow.dispose()
				post.dispose()
				nightAmbient.dispose()
				horizon.dispose()
				sky.dispose()
				tour.dispose()
				controls?.dispose()
				scene.remove( city.root )
			}

			cleanupExtras = cleanup
			return cleanup
		}

		let cleanupInner: () => void = () => {}
		boot()
			.then( ( fn ) => {
				cleanupInner = fn
			} )
			.catch( ( err: unknown ) => {
				console.error( '[rainy-night-webgpu] 雨夜启动失败', err )
				hostEl.textContent =
					'WebGPU / 夜景 / 雨系统初始化失败 · 请看控制台「雨夜主入口」。'
			} )

		return () => {
			disposed = true
			weatherAudio.dispose()
			fps.dispose()
			cleanupInner()
			cleanupExtras()
			if ( renderer ) {
				renderer.dispose()
				if ( renderer.domElement.parentNode === hostEl ) {
					hostEl.removeChild( renderer.domElement )
				}
			}
		}
	}, [] )

	return (
		<div ref={hostRef} style={{ width: '100%', height: '100%' }} />
	)
}
