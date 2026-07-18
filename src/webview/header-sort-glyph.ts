import type { SortKey } from '../types';

export interface HeaderSortMetadata {
    direction: 'asc' | 'desc';
    priority: number;
}

export function header_sort_metadata(
    sort: readonly SortKey[],
): Map<number, HeaderSortMetadata> {
    const metadata = new Map<number, HeaderSortMetadata>();
    sort.forEach((key, index) => metadata.set(key.colIndex, {
        direction: key.direction,
        priority: index + 1,
    }));
    return metadata;
}

export function draw_sort_glyphs(
    ctx: CanvasRenderingContext2D,
    rect: { x: number; y: number; width: number; height: number },
    theme: { textHeader: string; bgHeader: string; bgCell: string; fontFamily: string },
    entry: HeaderSortMetadata,
    show_badge: boolean,
): void {
    const primary = entry.priority === 1;
    const right = rect.x + rect.width - 8;
    const center_y = rect.y + rect.height / 2;
    const size = 5;
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.width, rect.height);
    ctx.clip();
    ctx.fillStyle = theme.textHeader;
    ctx.globalAlpha = primary ? 0.85 : 0.55;
    ctx.beginPath();
    if (entry.direction === 'asc') {
        ctx.moveTo(right - size, center_y + size / 2);
        ctx.lineTo(right, center_y + size / 2);
        ctx.lineTo(right - size / 2, center_y - size / 2);
    } else {
        ctx.moveTo(right - size, center_y - size / 2);
        ctx.lineTo(right, center_y - size / 2);
        ctx.lineTo(right - size / 2, center_y + size / 2);
    }
    ctx.closePath();
    ctx.fill();
    if (show_badge) {
        const badge_x = right - size - 10;
        ctx.globalAlpha = 1;
        ctx.fillStyle = theme.bgHeader === theme.bgCell
            ? 'rgba(128, 128, 128, 0.35)'
            : theme.bgCell;
        ctx.beginPath();
        ctx.arc(badge_x, center_y, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = theme.textHeader;
        ctx.font = `600 9px ${theme.fontFamily}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(entry.priority), badge_x, center_y + 0.5);
    }
    ctx.restore();
}
