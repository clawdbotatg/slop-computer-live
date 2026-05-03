"use client";

import type { ButtonHTMLAttributes, CSSProperties } from "react";
import { useState } from "react";
import { bevelStyle } from "./Bevel";

type Variant = "default" | "primary";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
};

export const Button = ({
  variant = "default",
  style,
  children,
  onMouseDown,
  onMouseUp,
  onMouseLeave,
  ...rest
}: ButtonProps) => {
  const [pressed, setPressed] = useState(false);

  const base: CSSProperties = {
    ...bevelStyle(pressed ? "inset" : "outset"),
    background: "var(--slop-panel-light)",
    color: variant === "primary" ? "var(--slop-accent)" : "var(--slop-text)",
    fontFamily: "var(--slop-font-display)",
    fontSize: 13,
    padding: "4px 14px",
    borderRadius: 0,
    cursor: rest.disabled ? "not-allowed" : "pointer",
    opacity: rest.disabled ? 0.5 : 1,
    userSelect: "none",
    transform: pressed ? "translate(1px, 1px)" : "none",
  };

  return (
    <button
      {...rest}
      style={{ ...base, ...style }}
      onMouseDown={e => {
        setPressed(true);
        onMouseDown?.(e);
      }}
      onMouseUp={e => {
        setPressed(false);
        onMouseUp?.(e);
      }}
      onMouseLeave={e => {
        setPressed(false);
        onMouseLeave?.(e);
      }}
    >
      {children}
    </button>
  );
};

export default Button;
