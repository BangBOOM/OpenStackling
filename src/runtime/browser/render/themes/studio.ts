import * as THREE from 'three';
import { THEME_VERSIONS } from '../../../theme-catalog';
import { createTheme, ROBOT_PALETTE, type ThemePlugin } from '../theme';
export default {
  id: 'studio',
  version: THEME_VERSIONS.studio,
  create() {
    return createTheme(
      {
        table: '#b8afa5',
        surface: '#eae4db',
        grid: '#d5cec4',
        ...ROBOT_PALETTE,
        blocks: ['#d56f5b', '#d6b051', '#6f9daa', '#9581ae', '#8da77b', '#7484a5'],
      },
      {
        background: '#e2ded8',
        sky: '#fffaf1',
        ground: '#aaa399',
        ambient: 2.8,
        sun: '#fff6e8',
        sunIntensity: 3.2,
        sunOffset: [-2, 6, 1],
      },
      ({ mesh }) => {
        // The physical workbench and its support frame belong to the shared scene.
        mesh(
          new THREE.PlaneGeometry(200, 200).rotateX(-Math.PI / 2),
          '#d6d0c7',
          0,
          -0.002,
          0,
        ).castShadow = false;
      },
    );
  },
} satisfies ThemePlugin;
