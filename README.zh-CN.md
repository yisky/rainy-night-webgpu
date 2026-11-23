# rainy-night-webgpu

[English](README.md) · 中文

three.js `0.186` WebGPU 雨夜城景：京都风小巷、雨丝、湿路、河面倒影、灯笼与偶发闪电。

在线演示：https://rainy-night-webgpu.vercel.app/

## 运行

```bash
pnpm install
pnpm dev
```

打开 http://localhost:5173/ 。需要支持 WebGPU 的浏览器。不支持就黑屏，不是场景没加载完。

## 操作

- 拖动 / 滚轮环视（导览播放时会关掉轨道）
- 右下角相机：开始步行浏览（空格 / Enter 同样有效）
- 右下角喇叭：雨声开关；第一次点击页面也会解锁音频

## 场景

- 城模 `public/models/city.glb`（KTX2 贴图 + meshopt），加载时挂 `KTX2Loader` 与 `MeshoptDecoder`
- 碰撞雨与高度图、落点水花
- 河面受光倒影与流动波纹
- 路面 / 桥湿膜与坑洼平面反射
- 灯笼点光与微闪、窗暖、店铺自发光
- 夜空、地平线填充、闪电折线
- 后处理：ACES 曝光、Bloom、体积雾、抖动

## 资源

- 城模：Sketchfab「Tanabata evening - Kyoto inspired city scene」（Mathias Tossens，CC-BY-4.0）
- 雨丝与涟漪实现参考：[ektogamat/threejs-conference](https://github.com/ektogamat/threejs-conference)
- 雨声 / 雷声：`public/audio/`
- Basis 转码器：`public/basis/`
