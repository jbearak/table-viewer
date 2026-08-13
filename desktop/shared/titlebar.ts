// the macOS themed title bar, shared by every window.
//
// Electron cannot make the native bar transparent while keeping its title (no
// titlebarAppearsTransparent/titleVisibility in the API), so each window asks for
// `titleBarStyle: 'hidden'` and the strip is redrawn here, in the page, from the
// window's own theme variables. `hidden` rather than `hiddenInset`: it leaves the
// traffic lights at the standard position, which macOS already centres in a bar
// of TITLEBAR_HEIGHT, so the strip and the buttons agree without guesswork.
//
// Pure DOM, no electron import: the viewer installs this from its preload (its
// page is the shared webview bundle, which knows nothing about the desktop),
// while the four dialog windows install it from their own renderers.
//
// Styles go through CSSOM rather than an injected <style> because the viewer
// page's CSP allows neither inline styles nor unnonced style elements — the same
// reason apply_theme_to_document sets custom properties directly. CSSOM is not
// subject to CSP, so one mechanism works for every window.

/**
 * Height of the macOS title bar this strip replaces, in CSS pixels at zoom 1.
 *
 * Measured rather than styled to taste: it is `getBounds().height -
 * getContentBounds().height` for a window that kept its native bar.
 */
export const TITLEBAR_HEIGHT = 32;

/** Strip height for this platform: TITLEBAR_HEIGHT where the themed strip
 *  replaces the native bar, 0 where the native bar remains. The `typeof` guard
 *  is for the renderers, which import this module without a `process`. */
export function titlebar_inset(): number {
    return typeof process !== 'undefined' && process.platform === 'darwin' ? TITLEBAR_HEIGHT : 0;
}

/**
 * The BrowserWindow options that trade the native macOS title bar for this
 * strip. `hidden` hides the bar and its title but keeps the traffic lights;
 * every window that spreads this must also install the strip, or it has no
 * title at all. Off macOS this is empty and the native bar stays.
 */
export const TITLEBAR_WINDOW_OPTIONS =
    titlebar_inset() ? { titleBarStyle: 'hidden' as const } : {};
/** Width of the traffic lights at the standard position, plus a gap. */
const TRAFFIC_LIGHT_GUTTER = 78;
const ELEMENT_ID = 'tv-titlebar';

/** macOS titles are the system font at 13px, whatever font the app itself uses:
 *  this strip stands in for window chrome, so it follows the system rather than
 *  the Preferences font the content honours. */
const TITLE_FONT = 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif';
const TITLE_FONT_SIZE = 13;
/** macOS window titles are semibold, not regular. */
const TITLE_FONT_WEIGHT = '600';
/**
 * Title colors: dimmed when the window is not the active one, the system's own cue
 * for which window has focus.
 *
 * Deliberately short of the full-strength label color even when active — over a
 * near-black editor background, 85% white reads as a glare rather than a title.
 * The reference is a native title over a mid-grey bar, where the same alpha looks
 * far softer than it does here.
 *
 * Keyed to the *theme's* kind rather than the OS appearance, which is what keeps
 * the title readable when a dark palette is chosen under a light system
 * appearance, or the reverse. `light-dark()` cannot do this: it resolves against
 * the used `color-scheme`, and src/webview/styles.css sets `light dark` on `body`
 * — so inside the page it follows the OS, not the palette.
 */
const TITLE_COLORS = {
    dark: { active: 'rgba(255, 255, 255, 0.65)', inactive: 'rgba(255, 255, 255, 0.3)' },
    light: { active: 'rgba(0, 0, 0, 0.65)', inactive: 'rgba(0, 0, 0, 0.3)' },
} as const;

/** Which palette the window is showing. Read from the `color-scheme` that every
 *  window sets on <html> from its theme kind (see apply_theme_to_document), so a
 *  theme switch needs no separate notification. */
function theme_kind(doc: Document): 'dark' | 'light' {
    const scheme = doc.defaultView?.getComputedStyle(doc.documentElement).colorScheme;
    return scheme === 'light' ? 'light' : 'dark';
}

/**
 * The title-bar slice of a chrome window's preload API — what
 * `install_titlebar_from_api` needs. Implemented once by
 * `titlebar_preload_api()` (desktop/preload/titlebar-api.ts).
 */
export interface TitlebarWindowApi {
    /** The strip height this window's renderer must draw and inset for, or 0
     *  where the native bar remains. */
    titlebar_inset: number;
    /** Whether this window is the active one, which dims the title when it is
     *  not, and a subscription to later changes. */
    titlebar_active(): boolean;
    on_titlebar_active(listener: (active: boolean) => void): void;
    /** This window's zoom factor, which the strip divides its metrics by so it
     *  stays the size of the window chrome it replaces, and a subscription to
     *  later changes. */
    titlebar_zoom(): number;
    on_titlebar_zoom(listener: (zoom: number) => void): void;
    /** A drag over the title text, which main turns into a window move (the
     *  text cannot be a drag region — see `TitlebarOptions.on_drag`). */
    drag_titlebar(phase: 'start' | 'move', x: number, y: number): void;
    /** Double-click on the title zooms the window, like a double-click
     *  anywhere else on a title bar. */
    zoom_titlebar_window(): void;
}

/**
 * Wire the strip to a chrome window's preload API: draw it with the window's
 * current title, zoom, and active state, and subscribe to later changes.
 *
 * The one call every dialog renderer makes — only the style differs per
 * window. A zero inset installs nothing and, deliberately, asks main nothing:
 * the zoom and active reads are synchronous IPC, wasted where the native bar
 * remains.
 */
export function install_titlebar_from_api(
    doc: Document,
    api: TitlebarWindowApi,
    style: TitlebarStyle,
): void {
    if (!api.titlebar_inset) return;
    install_titlebar(doc, {
        title: doc.title,
        inset: api.titlebar_inset,
        zoom: api.titlebar_zoom(),
        active: api.titlebar_active(),
        on_drag: (phase, x, y) => api.drag_titlebar(phase, x, y),
        on_zoom_window: () => api.zoom_titlebar_window(),
        style,
    });
    api.on_titlebar_zoom((zoom) => set_titlebar_zoom(doc, zoom));
    api.on_titlebar_active((active) => set_titlebar_active(doc, active));
}

export interface TitlebarStyle {
    /** The window's header band: its toolbar color where it has a toolbar for
     *  this strip to continue, and otherwise the window's own background — a
     *  band of its own would just be a stripe across a plain dialog. */
    background: string;
    /** Bottom rule, where the strip meets content it is distinct from. */
    border?: string;
}

export interface TitlebarOptions {
    title: string;
    /** Strip height at zoom 1, or 0 on the platforms that kept their native
     *  title bar. Callers pass TITLEBAR_HEIGHT on macOS. */
    inset: number;
    /** This window's current zoom factor (`webContents.getZoomFactor()`). */
    zoom?: number;
    /** Whether this window is the active one. Defaults to active. */
    active?: boolean;
    style: TitlebarStyle;
    /** The ancestor-path menu AppKit's proxy icon would have opened. Only a
     *  window representing a file has one, so this is optional. */
    on_path_menu?: () => void;
    /**
     * Move the window, in response to a drag over the title text.
     *
     * The text cannot be a drag region: a drag region swallows the mouse before
     * the page sees it, which is what the path-menu gestures need. So the strip
     * reports the drag and the main process moves the window — `phase: 'start'`
     * anchors it against the window's current bounds, and each `'move'` carries
     * the pointer's screen position in CSS pixels.
     */
    on_drag?: (phase: 'start' | 'move', x: number, y: number) => void;
    /** Zoom the window, for a double-click on the title — the other thing macOS
     *  does with a title bar, and the title text is part of the title bar. */
    on_zoom_window?: () => void;
}

/** What `set_titlebar_zoom` needs to re-derive the metrics on a zoom change. */
interface InstalledTitlebar {
    bar: HTMLElement;
    label: HTMLElement;
    /** Whether this window is the active one — dimmed when it is not. */
    active: boolean;
    inset: number;
    /** The page's own top padding, which the strip is added to rather than
     *  replacing — the dialog windows inset their content and would lose it. */
    body_padding: number;
}

let installed: InstalledTitlebar | undefined;

/**
 * Draw the strip and inset the page below it. A second call is a no-op, and an
 * `inset` of 0 installs nothing — the caller is on a platform whose native title
 * bar is still there.
 */
export function install_titlebar(doc: Document, options: TitlebarOptions): void {
    const { inset, style } = options;
    if (!inset || doc.getElementById(ELEMENT_ID)) return;

    const bar = doc.createElement('div');
    bar.id = ELEMENT_ID;
    const properties: Record<string, string> = {
        position: 'fixed',
        top: '0',
        left: '0',
        right: '0',
        display: 'flex',
        'align-items': 'center',
        // Left-aligned like the content below, starting clear of the traffic lights.
        'justify-content': 'flex-start',
        'box-sizing': 'border-box',
        background: style.background,
        'border-bottom': `1px solid ${style.border ?? 'transparent'}`,
        'font-family': TITLE_FONT,
        'font-weight': TITLE_FONT_WEIGHT,
        'z-index': '2147483647',
        // A drag across the strip would otherwise select the title text.
        '-webkit-user-select': 'none',
        '-webkit-app-region': 'drag',
    };
    for (const [property, value] of Object.entries(properties)) {
        bar.style.setProperty(property, value);
    }

    const label = doc.createElement('span');
    label.textContent = options.title;
    if (options.on_zoom_window) {
        const zoom_window = options.on_zoom_window;
        label.addEventListener('dblclick', () => zoom_window());
    }
    if (options.on_path_menu || options.on_drag || options.on_zoom_window) {
        // Opting out of the drag region is what lets the label see the mouse at
        // all; `on_drag` and `on_zoom_window` are then what keep the title bar's
        // own gestures — drag to move, double-click to zoom — working over it.
        label.style.setProperty('-webkit-app-region', 'no-drag');
    }
    if (options.on_path_menu) {
        const open_path_menu = options.on_path_menu;
        // AppKit opens the proxy icon's path menu on either gesture; match both.
        label.addEventListener('click', (event) => {
            if (event.metaKey) open_path_menu();
        });
        label.addEventListener('contextmenu', (event) => {
            event.preventDefault(); // The page's own menu must not also open.
            open_path_menu();
        });
    }
    if (options.on_drag) {
        const on_drag = options.on_drag;
        label.addEventListener('pointerdown', (event) => {
            // Left button only, and never the Cmd-click that opens the path menu.
            if (event.button !== 0 || event.metaKey) return;
            event.preventDefault();
            // Captured so the drag survives the pointer leaving the window —
            // which it does immediately, since the window moves with it.
            label.setPointerCapture(event.pointerId);
            on_drag('start', event.screenX, event.screenY);
        });
        label.addEventListener('pointermove', (event) => {
            if (!label.hasPointerCapture(event.pointerId)) return;
            on_drag('move', event.screenX, event.screenY);
        });
        label.addEventListener('pointerup', (event) => {
            if (label.hasPointerCapture(event.pointerId)) {
                label.releasePointerCapture(event.pointerId);
            }
        });
    }
    bar.append(label);

    const existing = Number.parseFloat(
        doc.defaultView?.getComputedStyle(doc.body).paddingTop ?? '0',
    );
    installed = {
        bar,
        label,
        active: options.active ?? true,
        inset,
        body_padding: Number.isFinite(existing) ? existing : 0,
    };
    apply_metrics(doc, options.zoom ?? 1);
    apply_title_color(doc);
    doc.body.style.setProperty('box-sizing', 'border-box');
    doc.body.append(bar);

    // A theme switch rewrites the custom properties on <html>, which is also where
    // the kind the title color is keyed to lives. Observing that is how the shared
    // webview already follows theme changes (see desktop/preload/viewer-preload.ts).
    const view = doc.defaultView;
    if (view) {
        new view.MutationObserver(() => apply_title_color(doc)).observe(doc.documentElement, {
            attributes: true,
            attributeFilter: ['style'],
        });
    }
}

/** Note this window's active state, dimming or restoring the title. The signal is
 *  the main process's window focus/blur: `document.hasFocus()` is true in every
 *  window of the app at once and cannot tell them apart. */
export function set_titlebar_active(doc: Document, active: boolean): void {
    if (!installed || installed.active === active) return;
    installed.active = active;
    apply_title_color(doc);
}

function apply_title_color(doc: Document): void {
    if (!installed) return;
    const colors = TITLE_COLORS[theme_kind(doc)];
    installed.label.style.setProperty('color', installed.active ? colors.active : colors.inactive);
}

/**
 * Re-derive the strip's metrics for a new window zoom factor.
 *
 * The strip lives in the page, so page zoom scales it along with the content —
 * but it stands in for window chrome, which macOS does not scale, and its height
 * has to keep matching the traffic lights drawn over it. Dividing every length by
 * the zoom factor holds the strip at a constant size on screen while the content
 * below it zooms.
 */
export function set_titlebar_zoom(doc: Document, zoom: number): void {
    if (!installed) return;
    apply_metrics(doc, zoom);
}

function apply_metrics(doc: Document, zoom: number): void {
    const { bar, inset, body_padding } = installed!;
    // A zero or negative factor cannot come from Electron, but it would divide
    // the strip out of existence rather than fail visibly.
    const scale = Number.isFinite(zoom) && zoom > 0 ? 1 / zoom : 1;
    bar.style.setProperty('height', `${inset * scale}px`);
    bar.style.setProperty('padding-left', `${TRAFFIC_LIGHT_GUTTER * scale}px`);
    bar.style.setProperty('border-bottom-width', `${scale}px`);
    bar.style.setProperty('font-size', `${TITLE_FONT_SIZE * scale}px`);
    doc.body.style.setProperty('padding-top', `${body_padding + inset * scale}px`);
}
