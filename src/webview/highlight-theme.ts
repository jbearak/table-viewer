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
