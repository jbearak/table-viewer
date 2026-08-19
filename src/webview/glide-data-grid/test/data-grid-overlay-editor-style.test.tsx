import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DataGridOverlayEditorStyle } from "../internal/data-grid-overlay-editor/data-grid-overlay-editor-style.js";

describe("DataGridOverlayEditorStyle", () => {
    it("keeps an ordinary cell as the editor minimum size", () => {
        const { getByTestId } = render(
            <DataGridOverlayEditorStyle
                data-testid="ordinary-overlay"
                targetX={20}
                targetY={30}
                targetWidth={180}
                targetHeight={32}
            />
        );

        const overlay = getByTestId("ordinary-overlay");
        expect(overlay.style.minWidth).toBe("min(180px, 400px, calc(100vw - 20px))");
        expect(overlay.style.minHeight).toBe("min(32px, calc(100vh - 40px))");
    });

    it("does not let a large cell override the editor viewport bounds", () => {
        const { getByTestId } = render(
            <DataGridOverlayEditorStyle
                data-testid="large-overlay"
                targetX={120}
                targetY={80}
                targetWidth={1_200}
                targetHeight={900}
            />
        );

        const overlay = getByTestId("large-overlay");
        expect(overlay.style.getPropertyValue("--gdg-overlay-pad"))
            .toBe("min(436px, max(0px, calc(50vh - 59px)))");
        expect(overlay.style.minWidth).toBe("min(1200px, 400px, calc(100vw - 20px))");
        expect(overlay.style.maxWidth).toBe("min(400px, calc(100vw - 20px))");
        expect(overlay.style.minHeight).toBe("min(900px, calc(100vh - 90px))");
        expect(overlay.style.maxHeight).toBe("calc(100vh - 90px)");
    });
});
