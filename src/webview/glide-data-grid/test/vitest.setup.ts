// Ported from upstream vitest.setup.js: canvas mock + ResizeObserver stub.
import "vitest-canvas-mock";
import { vi } from "vitest";

// vitest-canvas-mock is built against jest's global; point it at vi.
(globalThis as Record<string, unknown>).jest = vi;

// A real class: vitest 4 mock functions are not constructible with `new`.
(globalThis as Record<string, unknown>).ResizeObserver = class {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
};

Image.prototype.decode = () => new Promise(resolve => window.setTimeout(resolve, 10));
