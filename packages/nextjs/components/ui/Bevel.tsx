import React from "react";
import type { CSSProperties, ReactNode } from "react";

type BevelVariant = "outset" | "inset" | "out" | "in";

interface BevelProps {
  variant?: BevelVariant;
  background?: string;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
  as?: keyof React.JSX.IntrinsicElements;
}

const isInset = (v: BevelVariant) => v === "inset" || v === "in";

export const bevelStyle = (variant: BevelVariant = "outset"): CSSProperties =>
  isInset(variant)
    ? {
        borderTop: "1px solid var(--slop-bevel-dark)",
        borderLeft: "1px solid var(--slop-bevel-dark)",
        borderRight: "1px solid var(--slop-bevel-light)",
        borderBottom: "1px solid var(--slop-bevel-light)",
      }
    : {
        borderTop: "1px solid var(--slop-bevel-light)",
        borderLeft: "1px solid var(--slop-bevel-light)",
        borderRight: "1px solid var(--slop-bevel-dark)",
        borderBottom: "1px solid var(--slop-bevel-dark)",
      };

export const Bevel = ({
  variant = "outset",
  background,
  className = "",
  style,
  children,
  as: Tag = "div",
}: BevelProps) => {
  const cls = isInset(variant) ? "slop-bevel-in" : "slop-bevel-out";
  const defaultBg = isInset(variant) ? "var(--slop-bg)" : "var(--slop-panel)";
  const Component = Tag as React.ElementType;
  const mergedStyle = { background: background ?? defaultBg, ...style };
  return (
    <Component className={`${cls} ${className}`.trim()} style={mergedStyle}>
      {children}
    </Component>
  );
};

export default Bevel;
