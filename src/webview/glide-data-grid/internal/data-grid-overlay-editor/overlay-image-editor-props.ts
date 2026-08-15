import type * as React from "react";

// The image overlay editor itself is not vendored (this fork drops image
// cells), but its props type survives because it is part of the public
// editor-callback contract: `imageEditorOverride` and custom provideEditor
// components are typed against it.
export interface OverlayImageEditorProps {
    readonly urls: readonly string[];
    readonly canWrite: boolean;
    readonly onCancel: () => void;
    readonly onChange: (newImage: string) => void;
    readonly onEditClick?: () => void;
    readonly renderImage?: (url: string) => React.ReactNode;
}
