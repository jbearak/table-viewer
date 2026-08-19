// De-Linaria'd: upstream used a @linaria/react styled component. Static rules
// live in ../../styles.css under .gdg-overlay-editor; the position/size props
// become inline styles plus the --overlay-top custom property (kept because
// editor content sizes itself against it).
import * as React from "react";

interface Props extends React.HTMLAttributes<HTMLElement> {
    targetX: number;
    targetY: number;
    targetWidth: number;
    targetHeight: number;
    as?: "label";
}

export const DataGridOverlayEditorStyle = React.forwardRef<HTMLElement, Props>((p, ref) => {
    const { targetX, targetY, targetWidth, targetHeight, as, style, className, children, ...rest } = p;
    // `min-width: targetWidth` used to defeat the static 400px max-width whenever
    // a cell (especially a merge) was wider than that limit: CSS resolves a
    // min/max conflict in favour of the minimum. The same was true of a tall
    // wrapped-text row and max-height. Put the caps into the minima themselves so
    // the clip region can scroll instead of the editor taking over the viewport.
    // Horizontal overflow is translated back on screen by useStayOnScreen, so
    // width is bounded by the viewport rather than only the space to the right
    // of the cell (which could make an editor at the right edge unusably narrow).
    const availableWidth = "calc(100vw - 20px)";
    const availableHeight = `calc(100vh - ${targetY + 10}px)`;
    const targetPadding = Math.max(0, (targetHeight - 28) / 2);
    const availablePadding = `max(0px, calc(50vh - ${(targetY + 38) / 2}px))`;
    const dynamicStyle: React.CSSProperties & Record<"--overlay-top" | "--gdg-overlay-pad", string> = {
        "--overlay-top": `${targetY}px`,
        "--gdg-overlay-pad": `min(${targetPadding}px, ${availablePadding})`,
        left: targetX,
        top: targetY,
        minWidth: `min(${targetWidth}px, 400px, ${availableWidth})`,
        maxWidth: `min(400px, ${availableWidth})`,
        minHeight: `min(${targetHeight}px, ${availableHeight})`,
        maxHeight: availableHeight,
        ...style,
    };
    const cls = "gdg-overlay-editor " + (className ?? "");
    return React.createElement(as ?? "div", { ...rest, ref, className: cls, style: dynamicStyle }, children);
});
DataGridOverlayEditorStyle.displayName = "DataGridOverlayEditorStyle";
