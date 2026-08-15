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
    const dynamicStyle: React.CSSProperties & Record<"--overlay-top" | "--gdg-overlay-pad", string> = {
        "--overlay-top": `${targetY}px`,
        "--gdg-overlay-pad": `${Math.max(0, (targetHeight - 28) / 2)}px`,
        left: targetX,
        top: targetY,
        minWidth: targetWidth,
        minHeight: targetHeight,
        maxHeight: `calc(100vh - ${targetY + 10}px)`,
        ...style,
    };
    const cls = "gdg-overlay-editor " + (className ?? "");
    return React.createElement(as ?? "div", { ...rest, ref, className: cls, style: dynamicStyle }, children);
});
DataGridOverlayEditorStyle.displayName = "DataGridOverlayEditorStyle";
