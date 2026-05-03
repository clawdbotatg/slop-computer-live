import type { InputHTMLAttributes } from "react";
import { bevelStyle } from "./Bevel";

export const TextField = (props: InputHTMLAttributes<HTMLInputElement>) => (
  <input
    {...props}
    style={{
      ...bevelStyle("inset"),
      background: "var(--slop-bg)",
      color: "var(--slop-text)",
      fontFamily: "var(--slop-font-body)",
      fontSize: 13,
      padding: "4px 6px",
      borderRadius: 0,
      outline: "none",
      ...props.style,
    }}
  />
);

export default TextField;
