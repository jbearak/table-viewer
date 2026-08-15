// De-Linaria'd: upstream used a @linaria/react styled wrapper; the static
// rules live in ../../styles.css (.gdg-wrapper) and the dynamic width/height
// become inline styles (React renders bare numbers as px).
import * as React from "react";

interface Props extends React.HTMLAttributes<HTMLDivElement> {
    inWidth: number | string;
    inHeight: number | string;
}

export const DataEditorContainer: React.FC<Props> = p => {
    const { inWidth, inHeight, children, style, className, ...rest } = p;
    return (
        <div
            className={"gdg-wrapper " + (className ?? "")}
            style={{ ...style, width: inWidth, height: inHeight }}
            {...rest}>
            {children}
        </div>
    );
};
