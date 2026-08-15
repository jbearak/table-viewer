// De-Linaria'd: the styled input/container became plain classNames
// (.gdg-group-rename-input / .gdg-group-rename) in ../styles.css; the
// height-dependent min-height moved to an inline style.
import React from "react";
import ClickOutsideContainer from "../internal/click-outside-container/click-outside-container.js";
import type { Rectangle } from "../internal/data-grid/data-grid-types.js";

interface Props {
    readonly bounds: Rectangle;
    readonly group: string;
    readonly onClose: () => void;
    readonly onFinish: (newVal: string) => void;
    readonly canvasBounds: DOMRect;
}

export const GroupRename: React.FC<Props> = p => {
    const { bounds, group, onClose, canvasBounds, onFinish } = p;

    // Uncontrolled: the DOM input already holds the value; read it on Enter.
    return (
        <ClickOutsideContainer
            style={{
                position: "absolute",
                left: bounds.x - canvasBounds.left + 1,
                top: bounds.y - canvasBounds.top,
                width: bounds.width - 2,
                height: bounds.height,
            }}
            className="gdg-group-rename"
            onClickOutside={onClose}>
            <input
                className="gdg-group-rename-input"
                aria-label={`Rename group ${group}`}
                style={{ minHeight: Math.max(16, bounds.height - 10) }}
                data-testid="group-rename-input"
                defaultValue={group}
                onBlur={onClose}
                onFocus={e => e.currentTarget.select()}
                onKeyDown={e => {
                    if (e.key === "Enter") {
                        onFinish(e.currentTarget.value);
                    } else if (e.key === "Escape") {
                        onClose();
                    }
                }}
                autoFocus={true}
            />
        </ClickOutsideContainer>
    );
};
