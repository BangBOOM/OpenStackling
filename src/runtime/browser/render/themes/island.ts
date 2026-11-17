import * as THREE from 'three';
import { THEME_VERSIONS } from '../../../theme-catalog';
import { createTheme, ROBOT_PALETTE, type ThemePlugin } from '../theme';

export default {
  id: 'island',
  version: THEME_VERSIONS.island,
  create(layout) {
    return createTheme(
      {
        table: { color: '#bfcac5', roughness: 0.55, metalness: 0.25 },
        surface: '#e9e8df',
        grid: '#cdd1c7',
        ...ROBOT_PALETTE,
        blocks: ['#ed7962', '#edc65e', '#72b6b2', '#a48cc4', '#9bc597', '#82b6da'],
      },
      {
        background: '#e4ebe0',
        sky: '#eaf1f0',
        ground: '#909e7b',
        ambient: 1.9,
        sun: '#fff3de',
        sunIntensity: 3,
        sunOffset: [-3, 5, 3],
      },
      ({ mesh }) => {
        // The garden frames the station and leaves the front/right side open for future travel.
        const width = Math.max(4, layout.tableSize + 2.9);
        const depth = Math.max(3.5, layout.tableDepth + 2.8);
        const outline = new THREE.Shape();
        for (let i = 0; i <= 96; i++) {
          const a = (i / 96) * Math.PI * 2;
          const c = Math.cos(a),
            s = Math.sin(a);
          const x =
            (width / 2) * Math.sign(c) * Math.abs(c) ** 0.78 * (1 + 0.018 * Math.sin(a * 3));
          const z =
            (depth / 2) * Math.sign(s) * Math.abs(s) ** 0.78 * (1 + 0.025 * Math.cos(a * 3));
          if (i === 0) outline.moveTo(x, z);
          else outline.lineTo(x, z);
        }
        const ground = -0.001;
        const islandLayer = (thickness: number, bevel: number, top: number, color: string) =>
          mesh(
            new THREE.ExtrudeGeometry(outline, {
              depth: thickness - bevel * 2,
              bevelEnabled: true,
              bevelThickness: bevel,
              bevelSize: bevel,
              bevelSegments: 3,
              steps: 1,
            }).rotateX(-Math.PI / 2),
            color,
            0,
            top - thickness + bevel,
            0,
          );
        islandLayer(0.13, 0.015, ground - 0.04, '#c1b395');
        islandLayer(0.055, 0.012, ground, '#b5c79c');
        const branch = (from: THREE.Vector3, to: THREE.Vector3, radius: number) => {
          const center = from.clone().add(to).multiplyScalar(0.5);
          const object = mesh(
            new THREE.CylinderGeometry(radius * 0.65, radius, from.distanceTo(to), 10),
            '#8e8066',
            center.x,
            center.y,
            center.z,
          );
          object.quaternion.setFromUnitVectors(
            new THREE.Vector3(0, 1, 0),
            to.clone().sub(from).normalize(),
          );
        };
        const tree = (x: number, z: number, height: number, spread: number) => {
          branch(
            new THREE.Vector3(x, 0, z),
            new THREE.Vector3(x + 0.025, height * 0.73, z),
            height * 0.032,
          );
          for (const side of [-1, 1])
            branch(
              new THREE.Vector3(x, height * 0.4, z),
              new THREE.Vector3(x + side * spread * 0.25, height * 0.72, z + side * spread * 0.08),
              height * 0.016,
            );
          for (const [dx, dy, dz, scale, color] of [
            [-0.23, 0.7, 0.03, 0.34, '#75916b'],
            [0.2, 0.76, -0.06, 0.36, '#88a376'],
            [-0.01, 0.84, 0.03, 0.35, '#9bb487'],
            [0.09, 0.66, 0.2, 0.29, '#8aa879'],
          ] as const) {
            const crown = mesh(
              new THREE.IcosahedronGeometry(spread * scale, 2),
              color,
              x + dx * spread,
              height * dy,
              z + dz * spread,
            );
            crown.scale.set(1, (height / spread) * 0.55, 0.92);
          }
          const soil = mesh(
            new THREE.CylinderGeometry(spread * 0.32, spread * 0.32, 0.006, 32),
            '#a7ba90',
            x,
            0.001,
            z,
          );
          soil.castShadow = false;
        };
        tree(-width * 0.35, -depth * 0.27, 1.34, 0.94);
        tree(-width * 0.37, depth * 0.14, 0.86, 0.66);
        for (const [x, z, size] of [
          [-0.96, -1.38, 0.23],
          [-0.62, -1.43, 0.18],
          [-1.63, 0.95, 0.2],
        ]) {
          const shrub = mesh(new THREE.IcosahedronGeometry(size, 2), '#91aa7e', x, size * 0.58, z);
          shrub.scale.set(1.15, 0.72, 0.9);
        }
      },
    );
  },
} satisfies ThemePlugin;
