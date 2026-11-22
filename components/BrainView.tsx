import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Billboard, Environment, Lightformer, Line, OrbitControls, useGLTF } from "@react-three/drei";
import { Camera, Eye, EyeOff, Network, Move3D, Hand, Layers, Download, ChartNoAxesColumnIncreasing } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SCENARIOS, makeBrainModel } from "@/lib/brain-sim";
import { Box3, CanvasTexture, DoubleSide, Plane, Vector4, Group, Mesh, MeshStandardMaterial, RepeatWrapping, SRGBColorSpace, Vector3 } from "three";
import { SkeletonUtils } from "three-stdlib";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import brainModel from "@/assets/models/human-brain.glb.asset.json";
import type { ThreeEvent } from "@react-three/fiber";
import type { BrainRegion, RegionId, Scenario } from "@/lib/brain-sim";

const REGION_POSITIONS: Record<RegionId, [number, number, number]> = {
  frontal: [-1.35, 0.75, 1.05],
  parietal: [1.3, 0.9, 0.05],
  temporal: [-1.65, -0.25, 0.35],
  hippocampus: [0.35, -0.15, 1.55],
  entorhinal: [-0.95, -0.75, 1.05],
  occipital: [1.15, 0.3, -1.3],
};

const LABEL_OFFSETS: Record<RegionId, [number, number, number]> = {
  frontal: [0, 0.43, 0],
  parietal: [0, 0.55, 0],
  temporal: [-0.2, 0.43, 0],
  hippocampus: [0.25, 0.43, 0],
  entorhinal: [-0.3, -0.25, 0],
  occipital: [0.35, -0.2, 0],
};

function cssColor(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function makeSurfaceTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  if (!context) return null;
  const image = context.createImageData(64, 64);
  let seed = 19;
  for (let i = 0; i < image.data.length; i += 4) {
    seed = (seed * 16807) % 2147483647;
    const value = 105 + (seed % 55);
    image.data[i] = value;
    image.data[i + 1] = value;
    image.data[i + 2] = value;
    image.data[i + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  const texture = new CanvasTexture(canvas);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.repeat.set(4, 4);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

const MAX_DENTS = 4;
const DENT_RADIUS = 0.75; // world units
const DENT_DEPTH = 0.42; // world units pushed inward while held
const SPRING_K = 90; // reform stiffness
const SPRING_DAMP = 7; // lower = more jiggle on release

type Dent = { pos: Vector3; s: number; v: number; target: number };

type SliceAxis = "sagittal" | "coronal" | "axial";
type CameraView = "orbit" | "front" | "side" | "top";

function BrainModel({ onReady, deformMode, resetSignal, setOrbit, slice, sliceAxis, xray }: { sliceAxis: SliceAxis; slice: number; xray: boolean; onReady: () => void; deformMode: boolean; resetSignal: number; setOrbit: (on: boolean) => void }) {
  const dents = useRef<Dent[]>(Array.from({ length: MAX_DENTS }, () => ({ pos: new Vector3(), s: 0, v: 0, target: 0 })));
  const active = useRef<number>(-1);
  const next = useRef(0);
  const uniforms = useMemo(() => ({
    uDents: { value: Array.from({ length: MAX_DENTS }, () => new Vector4()) },
    uRadius: { value: DENT_RADIUS },
    uScale: { value: 1 },
    uTime: { value: 0 },
  }), []);
  const plane = useMemo(() => new Plane(new Vector3(-1, 0, 0), 3), []);
  const { scene } = useGLTF(brainModel.url);
  const announced = useRef(false);
  const model = useMemo(() => {
    const clone = SkeletonUtils.clone(scene);
    const remove: Mesh[] = [];
    const ownedMaterials: MeshStandardMaterial[] = [];
    const texture = makeSurfaceTexture();
    clone.traverse((child) => {
      if (!(child instanceof Mesh)) return;
      const sourceMaterials = Array.isArray(child.material) ? child.material : [child.material];
      if (sourceMaterials.some((material) => material.name === "wood" || material.name === "steel")) {
        remove.push(child);
        return;
      }
      const materials = sourceMaterials.map((source) => {
        const material = source.clone() as MeshStandardMaterial;
        material.roughness = 0.55;
        material.metalness = 0.02;
        material.clippingPlanes = [plane];
        material.side = DoubleSide;
        if (!material.map) {
          material.color.set(cssColor("--brain-webgl-surface"));
          material.bumpMap = texture;
          material.bumpScale = 0.025;
        }
        material.onBeforeCompile = (shader) => {
          Object.assign(shader.uniforms, uniforms);
          shader.vertexShader = shader.vertexShader
            .replace("#include <common>", `#include <common>
uniform vec4 uDents[${MAX_DENTS}];
uniform float uRadius; uniform float uScale; uniform float uTime;
varying float vDent;`)
            .replace("#include <begin_vertex>", `#include <begin_vertex>
vec3 wp = (modelMatrix * vec4(transformed, 1.0)).xyz;
float push = 0.0;
for (int i = 0; i < ${MAX_DENTS}; i++) {
  float d = distance(wp, uDents[i].xyz);
  float f = exp(-(d * d) / (uRadius * uRadius));
  push += uDents[i].w * f * (1.0 + 0.12 * sin(d * 14.0 - uTime * 9.0));
}
transformed -= objectNormal * push / uScale;
vDent = clamp(push / ${DENT_DEPTH.toFixed(2)}, 0.0, 1.0);`);
          shader.fragmentShader = shader.fragmentShader
            .replace("#include <common>", "#include <common>\nvarying float vDent;")
            .replace("#include <color_fragment>", "#include <color_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.55, 0.18, 0.22), vDent * 0.85);");
        };
        material.customProgramCacheKey = () => "alyra-deform";
        ownedMaterials.push(material);
        return material;
      });
      child.material = Array.isArray(child.material) ? materials : materials[0];
    });
    remove.forEach((mesh) => mesh.removeFromParent());
    clone.updateMatrixWorld(true);
    const box = new Box3().setFromObject(clone);
    const center = box.getCenter(new Vector3());
    const size = box.getSize(new Vector3());
    const scale = 4.25 / Math.max(size.x, size.y, size.z);
    clone.scale.setScalar(scale);
    clone.position.copy(center).multiplyScalar(-scale);
    const normalized = new Group();
    normalized.add(clone);
    uniforms.uScale.value = scale;
    return { normalized, ownedMaterials, texture };
  }, [scene, uniforms, plane]);

  useEffect(() => {
    plane.normal.set(sliceAxis === "sagittal" ? -1 : 0, sliceAxis === "axial" ? -1 : 0, sliceAxis === "coronal" ? -1 : 0);
    plane.constant = slice;
  }, [plane, slice, sliceAxis]);
  useEffect(() => {
    model.ownedMaterials.forEach((m) => { m.wireframe = xray; m.transparent = xray; m.opacity = xray ? 0.4 : 1; m.needsUpdate = true; });
  }, [model, xray]);

  useEffect(() => { dents.current.forEach((d) => { d.target = 0; }); }, [resetSignal]);

  const press = (event: ThreeEvent<PointerEvent>) => {
    if (!deformMode) return;
    event.stopPropagation();
    (event.target as Element | null)?.setPointerCapture?.(event.pointerId);
    const i = next.current; next.current = (i + 1) % MAX_DENTS;
    const dent = dents.current[i];
    if (!dent) return;
    dent.pos.copy(event.point); dent.target = DENT_DEPTH; dent.s = 0; dent.v = 0;
    active.current = i;
    setOrbit(false);
  };
  const drag = (event: ThreeEvent<PointerEvent>) => {
    if (active.current < 0) return;
    event.stopPropagation();
    dents.current[active.current]?.pos.lerp(event.point, 0.5);
  };
  const release = () => {
    const held = dents.current[active.current];
    if (held) held.target = 0;
    active.current = -1;
    setOrbit(true);
  };
  useEffect(() => {
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    return () => { window.removeEventListener("pointerup", release); window.removeEventListener("pointercancel", release); };
  });

  useEffect(() => () => {
    model.ownedMaterials.forEach((material) => material.dispose());
    model.texture?.dispose();
  }, [model]);

  useFrame(({ clock }, delta) => {
    const dt = Math.min(delta, 0.05);
    uniforms.uTime.value = clock.elapsedTime;
    dents.current.forEach((d, i) => {
      // semi-implicit spring: held dents sink in, released dents bounce back and settle
      d.v += (SPRING_K * (d.target - d.s) - SPRING_DAMP * d.v) * dt;
      d.s += d.v * dt;
      uniforms.uDents.value[i]?.set(d.pos.x, d.pos.y, d.pos.z, d.s);
    });
    if (!announced.current) {
      announced.current = true;
      onReady();
    }
  });

  return <primitive object={model.normalized} rotation={[0.04, -0.25, -0.04]} onPointerDown={deformMode ? press : undefined} onPointerMove={deformMode ? drag : undefined} />;
}

function RegionLabel({ region, selected, hovered, onPick, onHover }: {
  region: BrainRegion;
  selected: boolean;
  hovered: boolean;
  onPick: (id: RegionId) => void;
  onHover: (value: boolean) => void;
}) {
  const texture = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 128;
    const context = canvas.getContext("2d");
    if (!context) return null;
    const active = selected || hovered;
    context.globalAlpha = 0.92;
    context.fillStyle = cssColor("--brain-webgl-bg");
    context.beginPath();
    context.roundRect(4, 4, 504, 120, 12);
    context.fill();
    context.globalAlpha = 1;
    context.strokeStyle = cssColor(active ? "--brain-webgl-accent" : "--brain-webgl-signal");
    context.lineWidth = active ? 5 : 3;
    context.stroke();
    context.fillStyle = cssColor(active ? "--brain-webgl-accent" : "--brain-webgl-line");
    context.font = '500 30px "IBM Plex Mono", monospace';
    context.textBaseline = "middle";
    context.fillText(region.shortName, 28, 66);
    context.fillStyle = cssColor(active ? "--brain-webgl-accent" : "--brain-webgl-signal");
    context.font = '500 28px "IBM Plex Mono", monospace';
    context.textAlign = "right";
    context.fillText(`${Math.round(region.signal * 100)}%`, 482, 66);
    const label = new CanvasTexture(canvas);
    label.colorSpace = SRGBColorSpace;
    return label;
  }, [region.shortName, region.signal, selected, hovered]);
  useEffect(() => () => { texture?.dispose(); }, [texture]);

  return <sprite
    position={LABEL_OFFSETS[region.id]}
    scale={[1.6, 0.4, 1]}
    renderOrder={20}
    onClick={(event) => { event.stopPropagation(); onPick(region.id); }}
    onPointerOver={(event) => { event.stopPropagation(); onHover(true); }}
    onPointerOut={() => onHover(false)}
  >
    {texture && <spriteMaterial map={texture} transparent depthWrite={false} depthTest={false} />}
  </sprite>;
}

function RegionProbe({ region, selected, moving, onPick, labels }: {
  labels: boolean;
  region: BrainRegion;
  selected: boolean;
  moving: boolean;
  onPick: (id: RegionId) => void;
}) {
  const pulse = useRef<Group>(null);
  const [hovered, setHovered] = useState(false);
  const compact = useThree((state) => state.size.width < 600);
  const position = REGION_POSITIONS[region.id];
  useFrame(({ clock }) => {
    if (pulse.current && moving) {
      const scale = 1 + Math.sin(clock.elapsedTime * 2.2 + region.signal * 4) * 0.08;
      pulse.current.scale.setScalar(scale);
    }
  });
  useEffect(() => {
    if (hovered) document.body.style.cursor = "pointer";
    return () => { document.body.style.cursor = ""; };
  }, [hovered]);

  return <group position={position} scale={selected ? 1.16 : 1}>
    <group ref={pulse}>
      <Billboard>
        <mesh
          renderOrder={10}
          onClick={(event) => { event.stopPropagation(); onPick(region.id); }}
          onPointerOver={(event) => { event.stopPropagation(); setHovered(true); }}
          onPointerOut={() => setHovered(false)}
        >
          <circleGeometry args={[0.29, 32]} />
          <meshBasicMaterial color={cssColor("--brain-webgl-signal")} transparent opacity={0.1 + region.signal * 0.12} depthWrite={false} depthTest={false} />
        </mesh>
        <mesh renderOrder={11}>
          <ringGeometry args={[0.15, 0.19, 32]} />
          <meshBasicMaterial color={selected || hovered ? cssColor("--brain-webgl-accent") : cssColor("--brain-webgl-signal")} transparent opacity={0.95} depthWrite={false} depthTest={false} />
        </mesh>
        <mesh position={[0, 0, 0.01]} renderOrder={12}>
          <circleGeometry args={[0.045, 20]} />
          <meshBasicMaterial color={selected ? cssColor("--brain-webgl-accent") : cssColor("--brain-webgl-line")} transparent depthWrite={false} depthTest={false} />
        </mesh>
      </Billboard>
    </group>
    {labels && (!compact || selected || hovered) && <RegionLabel region={region} selected={selected} hovered={hovered} onPick={onPick} onHover={setHovered} />}
  </group>;
}

function CameraControls({ moving, resetSignal, enabled, view }: { view: CameraView; moving: boolean; resetSignal: number; enabled: boolean }) {
  const controls = useRef<OrbitControlsImpl>(null);
  const camera = useThree((state) => state.camera);
  useEffect(() => {
    camera.position.set(5.2, 3.1, 6.4);
    camera.lookAt(0, 0, 0);
    controls.current?.saveState();
  }, [camera]);
  useEffect(() => { controls.current?.reset(); }, [resetSignal]);
  useEffect(() => {
    const positions: Record<CameraView, [number, number, number]> = { orbit: [5.2, 3.1, 6.4], front: [0, 0.4, 7.5], side: [7.5, 0.4, 0], top: [0, 7.5, 0.01] };
    camera.position.set(...positions[view]);
    camera.lookAt(0, 0, 0);
    controls.current?.update();
  }, [camera, view]);
  return <OrbitControls ref={controls} makeDefault enabled={enabled} enablePan={false} enableDamping dampingFactor={0.08} rotateSpeed={0.8} zoomSpeed={0.9} minDistance={4.4} maxDistance={10} minPolarAngle={0.01} maxPolarAngle={Math.PI - 0.3} autoRotate={moving && enabled && view === "orbit"} autoRotateSpeed={0.55} />;
}

function NetworkOverlay({ picked, moving }: { picked?: RegionId | undefined; moving: boolean }) {
  const paths = useMemo(() => {
    const source = new Vector3(...REGION_POSITIONS[picked ?? "hippocampus"]);
    return Object.entries(REGION_POSITIONS).filter(([id]) => id !== (picked ?? "hippocampus")).map(([id, point]) => {
      const end = new Vector3(...point);
      return { id, points: Array.from({ length: 25 }, (_, i) => {
        const t = i / 24;
        const p = source.clone().lerp(end, t);
        p.y += Math.sin(t * Math.PI) * 0.6;
        return p;
      }) };
    });
  }, [picked]);
  const pulses = useRef<Group>(null);
  useFrame(({ clock }) => {
    if (!moving) return;
    pulses.current?.children.forEach((child, i) => {
      const path = paths[i];
      const point = path?.points[Math.floor(((clock.elapsedTime * 0.3 + i * 0.17) % 1) * 24)];
      if (point) child.position.copy(point);
    });
  });
  return <group>
    {paths.map((path) => <Line key={path.id} points={path.points} color={cssColor("--brain-webgl-accent")} lineWidth={1.2} transparent opacity={0.45} depthTest={false} />)}
    <group ref={pulses}>{paths.map((path) => <mesh key={path.id} position={path.points[0] ?? [0, 0, 0]}><sphereGeometry args={[0.045, 8, 8]} /><meshBasicMaterial color={cssColor("--brain-webgl-accent")} depthTest={false} /></mesh>)}</group>
  </group>;
}

function Scene({ regions, picked, onPick, moving, resetSignal, onReady, deformMode, slice, sliceAxis, xray, labels, network, view }: {
  sliceAxis: SliceAxis;
  labels: boolean;
  network: boolean;
  view: CameraView;
  slice: number;
  xray: boolean;
  deformMode: boolean;
  regions: BrainRegion[];
  picked?: RegionId | undefined;
  onPick: (id: RegionId) => void;
  moving: boolean;
  resetSignal: number;
  onReady: () => void;
}) {
  const [orbit, setOrbit] = useState(true);
  return <>
    <color attach="background" args={[cssColor("--brain-webgl-bg")]} />
    <fog attach="fog" args={[cssColor("--brain-webgl-bg"), 9, 17]} />
    <ambientLight intensity={0.65} />
    <hemisphereLight args={[cssColor("--brain-webgl-line"), cssColor("--brain-webgl-bg"), 1.25]} />
    <directionalLight position={[4, 6, 5]} intensity={2.1} color={cssColor("--brain-webgl-line")} />
    <pointLight position={[-4, 1, 3]} intensity={8} distance={10} color={cssColor("--brain-webgl-signal")} />
    <Environment resolution={64}>
      <Lightformer intensity={1.5} position={[0, 5, 0]} scale={[8, 8, 1]} color={cssColor("--brain-webgl-line")} />
      <Lightformer intensity={0.8} position={[-5, 1, 2]} rotation-y={Math.PI / 2} scale={[7, 2, 1]} color={cssColor("--brain-webgl-signal")} />
    </Environment>
    <Suspense fallback={null}><BrainModel onReady={onReady} deformMode={deformMode} resetSignal={resetSignal} setOrbit={setOrbit} slice={slice} sliceAxis={sliceAxis} xray={xray} /></Suspense>
    {network && <NetworkOverlay picked={picked} moving={moving} />}
    {regions.map((region) => <RegionProbe key={region.id} region={region} selected={picked === region.id} moving={moving} onPick={onPick} labels={labels} />)}
    <polarGridHelper args={[3.8, 12, 5, 48, cssColor("--brain-webgl-grid"), cssColor("--brain-webgl-grid")]} position={[0, -2.15, 0]} />
    <CameraControls moving={moving} resetSignal={resetSignal} enabled={orbit} view={view} />
  </>;
}

useGLTF.preload(brainModel.url);

export function BrainView({ regions, scenario, picked, onPick, moving, resetSignal }: {
  regions: BrainRegion[];
  scenario: Scenario;
  picked?: RegionId | undefined;
  onPick: (id: RegionId) => void;
  moving: boolean;
  resetSignal: number;
}) {
  const [ready, setReady] = useState(false);
  const [deformMode, setDeformMode] = useState(false);
  const [xray, setXray] = useState(false);
  const [cut, setCut] = useState(0);
  const [sliceAxis, setSliceAxis] = useState<SliceAxis>("sagittal");
  const [view, setView] = useState<CameraView>("orbit");
  const [network, setNetwork] = useState(false);
  const [labels, setLabels] = useState(true);
  const [compare, setCompare] = useState(false);
  const [comparison, setComparison] = useState("tau");
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const reducedMotion = useRef(false);
  useEffect(() => { reducedMotion.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches; }, []);
  useEffect(() => { setCut(0); setView("orbit"); setXray(false); setDeformMode(false); }, [resetSignal]);
  const otherScenario = SCENARIOS.find((item) => item.id === comparison);
  const comparisonRegions = otherScenario ? makeBrainModel(otherScenario) : [];
  function downloadView() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a"); link.href = url; link.download = `alyra-${scenario.id}-atlas.png`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }
  const slice = 2.4 - cut * 4.8;
  return <><div className="brain-tools" aria-label="Atlas tools">
    <div role="group" aria-label="Camera views"><Camera /><select aria-label="Camera view" value={view} onChange={(e) => setView(e.target.value as CameraView)}><option value="orbit">Free orbit</option><option value="front">Front view</option><option value="side">Side view</option><option value="top">Top view</option></select></div>
    <Button variant="ghost" size="sm" aria-pressed={network} onClick={() => setNetwork((v) => !v)}><Network />Connections</Button>
    <Button variant="ghost" size="sm" aria-label="Toggle region labels" title="Toggle region labels" aria-pressed={labels} onClick={() => setLabels((v) => !v)}>{labels ? <Eye /> : <EyeOff />}</Button>
    <Button variant="ghost" size="sm" aria-pressed={compare} onClick={() => setCompare((v) => !v)}><ChartNoAxesColumnIncreasing />Compare</Button>
    <Button variant="ghost" size="sm" aria-label="Download brain snapshot" title="Download brain snapshot" disabled={!ready} onClick={downloadView}><Download /></Button>
  </div><div className="brain-3d" data-scene-ready={ready ? "" : undefined}>
    <Canvas camera={{ position: [5.2, 3.1, 6.4], fov: 42, near: 0.1, far: 50 }} dpr={[1, 1.5]} performance={{ min: 0.6 }} gl={{ antialias: true, alpha: false, preserveDrawingBuffer: true }} onCreated={({ gl }) => { gl.localClippingEnabled = true; canvasRef.current = gl.domElement; }}>
      <Scene regions={regions} picked={picked} onPick={onPick} moving={moving && !reducedMotion.current} resetSignal={resetSignal} onReady={() => setReady(true)} deformMode={deformMode} slice={slice} sliceAxis={sliceAxis} xray={xray} labels={labels} network={network} view={view} />
    </Canvas>
    <div className="brain-3d-hud" aria-hidden="true"><span>ALYRA / 3D ATLAS</span><span>{scenario.name.toUpperCase()}</span></div>
    <div className="brain-3d-probe-nav" aria-label="Brain region probes">{regions.map((region, index) => <Button variant="ghost" size="icon" key={region.id} className={picked === region.id ? "selected" : ""} aria-pressed={picked === region.id} aria-label={`Probe ${region.name}`} title={region.name} onClick={() => onPick(region.id)}>0{index + 1}</Button>)}</div>
    <div className="brain-3d-mode" role="group" aria-label="Interaction mode">
      <Button variant="ghost" size="sm" aria-pressed={!deformMode} onClick={() => setDeformMode(false)}><Move3D />Rotate</Button>
      <Button variant="ghost" size="sm" aria-pressed={deformMode} onClick={() => setDeformMode(true)}><Hand />Squish</Button>
      <Button variant="ghost" size="sm" aria-pressed={xray} onClick={() => setXray((v) => !v)}><Layers />X-ray</Button>
    </div>
    <div className="brain-3d-slice"><select aria-label="Slice axis" value={sliceAxis} onChange={(e) => setSliceAxis(e.target.value as SliceAxis)}><option value="sagittal">Sagittal</option><option value="coronal">Coronal</option><option value="axial">Axial</option></select><input type="range" min={0} max={0.9} step={0.01} value={cut} onChange={(e) => setCut(Number(e.target.value))} aria-label="Slice the brain open" /><span>{Math.round(cut * 100)}%</span></div>
    <p className="brain-3d-instruction">{network ? "ILLUSTRATIVE CONNECTIONS · NOT MEASURED TRACTS" : "EDUCATIONAL ATLAS · NOT A PATIENT SCAN"}</p>
    {!ready && <div className="brain-3d-status" role="status">Preparing the 3D atlas…</div>}
  </div>{compare && <section className="brain-comparison" aria-label="Regional scenario comparison"><div className="brain-comparison-heading"><span>ILLUSTRATIVE REGIONAL SIGNALS</span><select aria-label="Comparison scenario" value={comparison} onChange={(e) => setComparison(e.target.value)}>{SCENARIOS.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div><div className="brain-comparison-legend"><span>{scenario.name}</span><span>{otherScenario?.name}</span></div>{regions.map((region) => {
    const other = comparisonRegions.find((item) => item.id === region.id);
    return <div className="brain-comparison-row" key={region.id}><Button variant="ghost" size="sm" onClick={() => onPick(region.id)}>{region.name}</Button><meter min={0} max={1} value={region.signal} aria-label={`${region.name} current signal`} /><span>{Math.round(region.signal * 100)}%</span><meter min={0} max={1} value={other?.signal ?? 0} aria-label={`${region.name} comparison signal`} /><span>{Math.round((other?.signal ?? 0) * 100)}%</span></div>;
  })}<p>Hand-set teaching values; not gene evidence, measured connectivity or clinical predictions.</p></section>}</>;
}
