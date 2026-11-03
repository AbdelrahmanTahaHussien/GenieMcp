import React from "react";

export interface ButtonProps {
  label: string;
  onClick?: () => void;
}

// The "ui" (design 1.0) Button.
export default function Button({ label, onClick }: ButtonProps) {
  return <button onClick={onClick}>{label}</button>;
}
