import { useId, useState } from "react";

import { Eye, EyeOff } from "lucide-react";

import { TEXT_INPUT_BASE } from "../lib/input-styles";

/** A password field with a show/hide reveal toggle. Shared by the auth forms. */
export function PasswordInput({
  value,
  onChange,
  autoComplete,
  required,
  minLength,
  placeholder,
  id,
}: {
  value: string;
  onChange: (value: string) => void;
  autoComplete?: string;
  required?: boolean;
  minLength?: number;
  placeholder?: string;
  id?: string;
}) {
  const [reveal, setReveal] = useState(false);
  const fallbackId = useId();
  const inputId = id ?? fallbackId;

  return (
    <div className="relative">
      <input
        id={inputId}
        type={reveal ? "text" : "password"}
        autoComplete={autoComplete}
        required={required}
        minLength={minLength}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`${TEXT_INPUT_BASE} pl-2.5 pr-10`}
      />
      <button
        type="button"
        onClick={() => setReveal((prev) => !prev)}
        aria-label={reveal ? "Hide password" : "Show password"}
        aria-pressed={reveal}
        aria-controls={inputId}
        className="absolute inset-y-0 right-0 flex items-center px-2.5 text-muted transition-colors hover:text-ink"
      >
        {reveal ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
      </button>
    </div>
  );
}
