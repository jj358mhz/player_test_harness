import {defineConfig} from 'vitest/config';

// Builds the player into Flask's static folder. Flask renders the page
// (templates/main/player.html) and reads .vite/manifest.json to find the
// hashed entry files, so there is no Vite dev server in the loop.
export default defineConfig({
    base: '/static/player/',
    build: {
        outDir: '../app/static/player',
        emptyOutDir: true,
        manifest: true,
        sourcemap: true,
        rollupOptions: {input: ['src/main.ts', 'src/recording.ts']},
    },
    test: {
        environment: 'jsdom',
        include: ['test/**/*.test.ts'],
    },
});
