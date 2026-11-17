import type { Plugin } from 'vite';

// Load the host through Bun after Vite has loaded its configuration. The host
// executes Episode and the native addon; it is never part of a browser bundle.
export function runtimeHostPlugin(): Plugin {
  const load = async () => {
    const url = new URL('./server.ts', import.meta.url).href;
    return import(url) as Promise<typeof import('./server')>;
  };
  return {
    name: 'stackling-runtime-host',
    async configureServer(server) {
      (await load()).attach(server.httpServer!);
    },
    async configurePreviewServer(server) {
      (await load()).attach(server.httpServer);
    },
  };
}
