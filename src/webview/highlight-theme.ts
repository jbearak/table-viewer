import {
    CELL_HIGHLIGHT_COLORS,
    type CellHighlightColor,
} from '../types';

export { CELL_HIGHLIGHT_COLORS };

const NORMAL: Record<CellHighlightColor, string> = {
    yellow: 'rgba(255, 193, 7, 0.24)',
    green: 'rgba(46, 160, 67, 0.22)',
    blue: 'rgba(33, 150, 243, 0.22)',
    pink: 'rgba(233, 30, 99, 0.20)',
};

const HIGH_CONTRAST: Record<CellHighlightColor, string> = {
    yellow: 'rgba(255, 193, 7, 0.38)',
    green: 'rgba(46, 160, 67, 0.38)',
    blue: 'rgba(33, 150, 243, 0.38)',
    pink: 'rgba(233, 30, 99, 0.38)',
};

export function highlight_rgba(
    color: CellHighlightColor,
    high_contrast: boolean,
): string {
    return (high_contrast ? HIGH_CONTRAST : NORMAL)[color];
}

export function highlight_label(color: CellHighlightColor): string {
    return color[0].toUpperCase() + color.slice(1);
}

/**
 * The tint an undo or redo briefly paints over the region it changed.
 *
 * Deliberately not one of the persistent highlight colours: a flash that looked
 * like a yellow cell highlight would read as "the undo highlighted these cells"
 * for as long as it lasted. Stronger than the persistent tints too, since it has
 * under a second to be noticed — including on a sheet the switch just revealed.
 */
export function history_flash_rgba(high_contrast: boolean): string {
    return high_contrast
        ? 'rgba(137, 87, 229, 0.52)'
        : 'rgba(137, 87, 229, 0.34)';
}
