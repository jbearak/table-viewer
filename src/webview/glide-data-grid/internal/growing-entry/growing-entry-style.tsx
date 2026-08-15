// De-Linaria'd: upstream defined these as @linaria/react styled components.
// The rules now live in ../../styles.css under the matching class names.
import * as React from "react";

export const InputBox = React.forwardRef<
    HTMLTextAreaElement,
    React.DetailedHTMLProps<React.TextareaHTMLAttributes<HTMLTextAreaElement>, HTMLTextAreaElement>
>((props, ref) => (
    <textarea {...props} ref={ref} className={"gdg-input-box " + (props.className ?? "")} />
));
InputBox.displayName = "InputBox";

export const ShadowBox: React.FC<React.HTMLAttributes<HTMLDivElement>> = props => (
    <div {...props} className={"gdg-shadow-box " + (props.className ?? "")} />
);

export const GrowingEntryStyle: React.FC<React.HTMLAttributes<HTMLDivElement>> = props => (
    <div {...props} className={"gdg-growing-entry-style " + (props.className ?? "")} />
);
