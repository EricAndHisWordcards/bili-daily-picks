/** 通用小控件：开关、步进器、分段切换、下拉框。 */
import type { ReactNode } from 'react';
import { IconChevronDown } from './Icons';

/* ------------------------------------------------------------------ */

interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
  testid?: string;
}

export function Switch({ checked, onChange, disabled, label, testid }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      data-testid={testid}
      className={`switch ${checked ? 'is-on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-knob" />
    </button>
  );
}

/* ------------------------------------------------------------------ */

interface StepperProps {
  value: number;
  min: number;
  max: number;
  onChange: (next: number) => void;
  disabled?: boolean;
  testid?: string;
  label: string;
}

export function Stepper({ value, min, max, onChange, disabled, testid, label }: StepperProps) {
  return (
    <div className="stepper" data-testid={testid} role="group" aria-label={label}>
      <button
        type="button"
        className="stepper-btn"
        aria-label={`${label}减少`}
        disabled={disabled || value <= min}
        onClick={() => onChange(Math.max(min, value - 1))}
      >
        −
      </button>
      <span className="stepper-value" aria-live="polite">
        {value}
      </span>
      <button
        type="button"
        className="stepper-btn"
        aria-label={`${label}增加`}
        disabled={disabled || value >= max}
        onClick={() => onChange(Math.min(max, value + 1))}
      >
        +
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

interface SegmentedProps<T extends string> {
  value: T;
  options: ReadonlyArray<SegmentedOption<T>>;
  onChange: (next: T) => void;
  label: string;
  testid?: string;
  disabled?: boolean;
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  testid,
  disabled,
}: SegmentedProps<T>) {
  return (
    <div className="segmented" role="group" aria-label={label} data-testid={testid}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`segmented-btn ${option.value === value ? 'is-active' : ''}`}
          aria-pressed={option.value === value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */

interface SelectFieldProps {
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (next: string) => void;
  label: string;
  testid?: string;
  disabled?: boolean;
}

export function SelectField({
  value,
  options,
  onChange,
  label,
  testid,
  disabled,
}: SelectFieldProps) {
  return (
    <span className="select-wrap">
      <select
        className="select"
        aria-label={label}
        value={value}
        disabled={disabled}
        data-testid={testid}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <IconChevronDown size={14} className="select-arrow" />
    </span>
  );
}

/* ------------------------------------------------------------------ */

export function SettingRow({
  title,
  description,
  control,
  children,
}: {
  title: string;
  description?: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="setting-row">
      <div className="setting-copy">
        <span className="setting-title">{title}</span>
        {description && <p className="setting-desc">{description}</p>}
        {children}
      </div>
      {control && <div className="setting-control">{control}</div>}
    </div>
  );
}
