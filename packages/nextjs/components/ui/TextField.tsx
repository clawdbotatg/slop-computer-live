import type { InputHTMLAttributes } from "react";

export type TextFieldProps = InputHTMLAttributes<HTMLInputElement>;

export const TextField = ({ className = "", ...rest }: TextFieldProps) => (
  <input className={`slop-textfield ${className}`.trim()} {...rest} />
);

export default TextField;
