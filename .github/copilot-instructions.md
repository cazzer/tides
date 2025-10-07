# Tides: Solar System Simulation

## Architecture Overview

This is a React Three Fiber (R3F) application that simulates a solar system with the Sun, Earth, and Moon. The app uses:

- **Three.js/R3F** for 3D rendering with custom GLSL shaders
- **Zustand** for global state management
- **D3.js** scales for astronomical unit conversion
- **Luxon/SunCalc** for real astronomical calculations
- **Vite** with custom GLSL shader loading

## Key Components & Patterns

### Multi-View Layout System

The app renders **three synchronized 3D views** using R3F's `View` system:

- Main solar system view (`gridArea: "main"`)
- Earth surface view (`gridArea: "top"`)
- Moon surface view (`gridArea: "bottom"`)

All views share the same scene matrix but use different cameras. See `App.tsx` Panel components.

### OrbitingBody Pattern

`OrbitingBody.tsx` is the core abstraction - handles orbital mechanics, rotation, and parent-child relationships:

```tsx
<OrbitingBody
  parent={sun} // Hierarchical orbiting
  orbitalDistance={scaleOrbit()} // D3 scaled distances
  orbitalPeriod={earthOrbitalPeriod}
  rotationPeriod={24 * 3600000} // Real astronomical periods
  axialTilt={23.4} // Earth's tilt in degrees
>
  <EarthRenderer />
</OrbitingBody>
```

### Time System & Animation

- **Global time state** in Zustand store drives all animations
- `useFrame` hook updates timestamp every frame with configurable `timeScale`
- **Jump-to-date** feature uses D3 easing for smooth transitions
- All calculations use milliseconds as base unit

### Shader Architecture

Custom GLSL shaders in `/src/shaders/` with vite-plugin-glsl:

- Sun uses noise-based procedural shaders (`sun-noise/`)
- Planets use texture-based materials
- Import shaders: `import vertex from './path/vertex.glsl'`

## Development Workflows

### Build & Deploy

```bash
npm run dev          # Development server
npm run build        # Builds to /docs for GitHub Pages
npm run preview      # Preview production build
```

### Scaling Constants

Use D3 scales for realistic astronomical proportions:

- `scaleDiameter()` - Log scale for planet sizes (3.47M km → 1.39B km)
- `scaleOrbit()` - Linear scale for distances (384M km → 149B km)

### Adding New Celestial Bodies

1. Create renderer in `/renderers/` following existing patterns
2. Add OrbitingBody with astronomical parameters
3. Use real orbital/rotation periods in milliseconds
4. Add texture assets to `/src/assets/`

## Critical Dependencies

- **@react-three/fiber**: R3F core
- **@react-three/drei**: Camera controls, utilities
- **vite-plugin-glsl**: Shader imports (`.glsl`, `.frag` files)
- **suncalc**: Real astronomical position calculations
- **luxon**: Date/time handling for celestial mechanics
- **zustand**: Minimal global state (time, planet refs)

## Common Patterns

- Planet refs stored in Zustand for cross-component camera targeting
- Astronomical periods use real values (Earth: 365.256 days = 31,557,600,000ms)
- Grid layout with responsive design via CSS Grid
- forwardRef pattern for Three.js object access
- D3 easing functions for smooth animations
