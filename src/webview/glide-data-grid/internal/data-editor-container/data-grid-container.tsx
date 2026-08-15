// De-Linaria'd: upstream used a @linaria/react styled wrapper; the static
// rules live in ../../styles.css (.gdg-wrapper) and the dynamic width/height
// become inline styles.
import * as React from "react";

interface WrapperProps {
    inWidth: number | string;
    inHeight: number | string;
}

function toCss(x: number | string) {
    if (typeof x === "string") return x;
    return `${x}px`;
}

interface Props extends WrapperProps, React.HTMLAttributes<HTMLDivElement> {}

export const DataEditorContainer: React.FunctionComponent<React.PropsWithChildren<Props>> = p => {
    const { inWidth, inHeight, children, style, className, ...rest } = p;
    return (
        <div
            className={"gdg-wrapper " + (className ?? "")}
            style={{ ...style, width: toCss(inWidth), height: toCss(inHeight) }}
            {...rest}>
            {children}
        </div>
    );
};
