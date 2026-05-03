import React from "react";

type Variant = "default" | "primary";

type CommonProps = {
  variant?: Variant;
  className?: string;
  children: React.ReactNode;
  style?: React.CSSProperties;
};

type ButtonAsButton = CommonProps & {
  as?: "button";
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children" | "style">;

type ButtonAsAnchor = CommonProps & {
  as: "a";
  href: string;
} & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "className" | "children" | "style" | "href">;

export type ButtonProps = ButtonAsButton | ButtonAsAnchor;

const buttonClass = (variant: Variant, className?: string) =>
  `slop-button${variant === "primary" ? " slop-button--primary" : ""}${className ? ` ${className}` : ""}`;

export const Button = (props: ButtonProps) => {
  const variant = props.variant ?? "default";
  const cls = buttonClass(variant, props.className);

  if (props.as === "a") {
    const { children, href, target, rel, onClick, id, role, style, "aria-label": ariaLabel } = props;
    return (
      <a
        className={cls}
        href={href}
        target={target}
        rel={rel}
        onClick={onClick}
        id={id}
        role={role}
        style={style}
        aria-label={ariaLabel}
      >
        {children}
      </a>
    );
  }

  const { children, type, onClick, disabled, id, name, style, "aria-label": ariaLabel } = props;
  return (
    <button
      className={cls}
      type={type ?? "button"}
      onClick={onClick}
      disabled={disabled}
      id={id}
      name={name}
      style={style}
      aria-label={ariaLabel}
    >
      {children}
    </button>
  );
};

export default Button;
