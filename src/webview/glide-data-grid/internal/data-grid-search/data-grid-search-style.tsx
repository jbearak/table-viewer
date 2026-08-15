// De-Linaria'd: upstream used a @linaria/react styled component; the rules
// (including the fade keyframes) live in ../../styles.css under
// .gdg-search-wrapper.
import * as React from "react";

export const SearchWrapper: React.FC<React.HTMLAttributes<HTMLDivElement>> = props => (
    <div {...props} className={"gdg-search-wrapper " + (props.className ?? "")} />
);
