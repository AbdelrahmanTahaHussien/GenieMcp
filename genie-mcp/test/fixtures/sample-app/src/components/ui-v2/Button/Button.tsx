import React from "react";

export interface ButtonProps {
  text: string;
  variant?: "primary" | "secondary";
}

// The "ui-v2" (design 2.0) Button — same name, different file.
export default function Button({ text }: ButtonProps) {
  return <button data-v2>{text}</button>;
}
