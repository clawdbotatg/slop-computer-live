import type { CSSProperties, ReactNode } from "react";

type BevelVariant = "outset" | "inset";

type BevelProps = {
  variant?: BevelVariant;
  background?: string;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
  as?: keyof React.JSX.IntrinsicElements;
};

const outsetBorders: CSSProperties = {
  borderTop: "1px solid var(--slop-bevel-light)",
  borderLeft: "1px solid var(--slop-bevel-light)",
  borderRight: "1px solid var(--slop-bevel-dark)",
  borderBottom: "1px solid var(--slop-bevel-dark)",
};

const insetBorders: CSSProperties = {
  borderTop: "1px solid var(--slop-bevel-dark)",
  borderLeft: "1px solid var(--slop-bevel-dark)",
  borderRight: "1px solid var(--slop-bevel-light)",
  borderBottom: "1px solid var(--slop-bevel-light)",
};

export const bevelStyle = (variant: BevelVariant = "outset"): CSSProperties =>
  variant === "inset" ? insetBorders : outsetBorders;

export const Bevel = ({
  variant = "outset",
  background = "var(--slop-panel)",
  className,
  style,
  children,
  as = "div",
}: BevelProps) => {
  const Tag = as as any;
  return (
    <Tag
      className={className}
      style={{
        ...bevelStyle(variant),
        background,
        borderRadius: 0,
        ...style,
      }}
    >
      {children}
    </Tag>
  );
};

export default Bevel;
