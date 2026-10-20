/** 手写内联 SVG 图标：不引入任何图标库，统一 currentColor 描边。 */
import type { ReactNode } from 'react';

export interface IconProps {
  size?: number;
  className?: string;
  strokeWidth?: number;
}

interface SvgProps extends IconProps {
  children: ReactNode;
}

function Svg({ size = 16, className, strokeWidth = 1.8, children }: SvgProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function IconToday(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.2" y="4.8" width="17.6" height="16" rx="3" />
      <path d="M3.2 9.4h17.6M8.2 3v3.4M15.8 3v3.4" />
      <path d="m12 12.4 1.1 2.2 2.4.35-1.74 1.7.41 2.4L12 17.95l-2.17 1.1.41-2.4-1.74-1.7 2.4-.35z" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconSections(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.4" y="3.4" width="7.2" height="7.2" rx="2" />
      <rect x="13.4" y="3.4" width="7.2" height="7.2" rx="2" />
      <rect x="3.4" y="13.4" width="7.2" height="7.2" rx="2" />
      <rect x="13.4" y="13.4" width="7.2" height="7.2" rx="2" />
    </Svg>
  );
}

export function IconTrend(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.4 16.6 9 11l3.4 3.2L20.6 6.8" />
      <path d="M15.6 6.8h5v5" />
    </Svg>
  );
}

export function IconTag(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M20.6 13.2 13.4 20.4a2 2 0 0 1-2.83 0L3.6 13.4V4.4a.8.8 0 0 1 .8-.8h9l7.2 7.2a2 2 0 0 1 0 2.4z" />
      <circle cx="8.3" cy="8.3" r="1.4" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconSettings(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="3.1" />
      <path d="M19.2 12a7.2 7.2 0 0 0-.1-1.2l2-1.55-1.9-3.3-2.36.95a7.3 7.3 0 0 0-2.08-1.2L14.4 3h-4.8l-.36 2.7a7.3 7.3 0 0 0-2.08 1.2l-2.36-.95-1.9 3.3 2 1.55a7.2 7.2 0 0 0 0 2.4l-2 1.55 1.9 3.3 2.36-.95a7.3 7.3 0 0 0 2.08 1.2L9.6 21h4.8l.36-2.7a7.3 7.3 0 0 0 2.08-1.2l2.36.95 1.9-3.3-2-1.55c.06-.39.1-.79.1-1.2z" />
    </Svg>
  );
}

export function IconRefresh(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M20.2 11.2a8.2 8.2 0 1 1-2.5-5.8" />
      <path d="M20.4 4.4v5.2h-5.2" />
    </Svg>
  );
}

export function IconPlay(props: IconProps) {
  return (
    <Svg {...props} strokeWidth={0}>
      <path d="M8 5.4c0-.8.86-1.3 1.55-.9l9.1 5.9c.65.42.65 1.38 0 1.8l-9.1 5.9c-.69.4-1.55-.1-1.55-.9z" fill="currentColor" />
    </Svg>
  );
}

export function IconStar(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m12 3.8 2.55 5.17 5.7.83-4.13 4.02.98 5.68L12 16.82l-5.1 2.68.98-5.68-4.13-4.02 5.7-.83z" />
    </Svg>
  );
}

export function IconComment(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M20.4 11.6a7.9 7.9 0 0 1-8.4 7.9 9 9 0 0 1-3.1-.6L4 20.4l1.5-4.2a7.7 7.7 0 0 1-1.5-4.6A7.9 7.9 0 0 1 12.2 3.7a7.9 7.9 0 0 1 8.2 7.9z" />
    </Svg>
  );
}

export function IconClock(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 7.4V12l3.1 1.9" />
    </Svg>
  );
}

export function IconExternal(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M14 4.6h5.4V10" />
      <path d="M19.4 4.6 11.6 12.4" />
      <path d="M19.4 13.4v4.4a1.6 1.6 0 0 1-1.6 1.6H5.8a1.6 1.6 0 0 1-1.6-1.6V5.8a1.6 1.6 0 0 1 1.6-1.6h4.4" />
    </Svg>
  );
}

export function IconChevronRight(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m9.4 5.8 6.2 6.2-6.2 6.2" />
    </Svg>
  );
}

export function IconChevronDown(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m5.8 9.4 6.2 6.2 6.2-6.2" />
    </Svg>
  );
}

export function IconClose(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m6 6 12 12M18 6 6 18" />
    </Svg>
  );
}

export function IconCheck(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m4.8 12.6 4.7 4.7L19.4 7" />
    </Svg>
  );
}

export function IconInfo(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 11v5.2M12 7.9v.2" />
    </Svg>
  );
}

export function IconAlert(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M10.3 4.2 2.9 17.2a2 2 0 0 0 1.7 3h14.8a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z" />
      <path d="M12 9.2v4.4M12 17v.2" />
    </Svg>
  );
}

export function IconSpark(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3.4c.7 3.8 2.8 5.9 6.6 6.6-3.8.7-5.9 2.8-6.6 6.6-.7-3.8-2.8-5.9-6.6-6.6 3.8-.7 5.9-2.8 6.6-6.6z" />
      <path d="M18.6 15.4c.3 1.7 1.3 2.7 3 3-1.7.3-2.7 1.3-3 3-.3-1.7-1.3-2.7-3-3 1.7-.3 2.7-1.3 3-3z" />
    </Svg>
  );
}

export function IconTv(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2.6" y="6.4" width="18.8" height="13.2" rx="3.2" />
      <path d="m8.2 2.8 3.8 3.2 3.8-3.2" />
      <path d="M10.6 10.4v5.2l4.6-2.6z" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconUser(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="8.2" r="3.8" />
      <path d="M4.8 20.2a7.2 7.2 0 0 1 14.4 0" />
    </Svg>
  );
}

export function IconLock(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="4.6" y="10.2" width="14.8" height="10.2" rx="2.6" />
      <path d="M8.2 10.2V7.8a3.8 3.8 0 0 1 7.6 0v2.4" />
    </Svg>
  );
}

export function IconTrash(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.4 6.8h15.2M9.4 6.4V4.6h5.2v1.8" />
      <path d="M6.4 6.8 7.2 19a1.6 1.6 0 0 0 1.6 1.5h6.4a1.6 1.6 0 0 0 1.6-1.5l.8-12.2" />
      <path d="M10.2 10.4v6M13.8 10.4v6" />
    </Svg>
  );
}

export function IconShield(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3.2 19.4 6v5.4c0 4.4-3 7.7-7.4 9.4-4.4-1.7-7.4-5-7.4-9.4V6z" />
      <path d="m8.8 11.8 2.1 2.1 4.3-4.3" />
    </Svg>
  );
}

export function IconFire(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3.2c.6 3-1.5 4.4-2.8 6-1.3 1.7-2.2 3.1-2.2 5a5 5 0 0 0 10 0c0-1.6-.6-2.8-1.5-4.2-.9 1-1.7 1.4-2.3 1.2.6-3.1.5-5.6-1.2-8z" />
    </Svg>
  );
}

/** 周报：日历（不带星标，与今日必看区分） */
export function IconCalendar(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.2" y="4.8" width="17.6" height="16" rx="3" />
      <path d="M3.2 9.4h17.6M8.2 3v3.4M15.8 3v3.4" />
      <path d="M7.4 13.2h3.2M13.4 13.2h3.2M7.4 17h3.2M13.4 17h3.2" />
    </Svg>
  );
}

/** 导出备份：箭头向下进入托盘 */
export function IconDownload(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3.6v10.2" />
      <path d="m7.6 9.6 4.4 4.4 4.4-4.4" />
      <path d="M4.4 16.4v2.2a1.8 1.8 0 0 0 1.8 1.8h11.6a1.8 1.8 0 0 0 1.8-1.8v-2.2" />
    </Svg>
  );
}

/** 导入备份：箭头向上离开托盘 */
export function IconUpload(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 14.2V4" />
      <path d="m7.6 8.4 4.4-4.4 4.4 4.4" />
      <path d="M4.4 16.4v2.2a1.8 1.8 0 0 0 1.8 1.8h11.6a1.8 1.8 0 0 0 1.8-1.8v-2.2" />
    </Svg>
  );
}

/** 兴趣信号：脉冲线条 */
export function IconSignal(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.4 12.6h3.2l2.2-6.2 3.4 11.2 2.4-7 1.8 2h4.2" />
    </Svg>
  );
}

/** B 站电视风格品牌标 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span className={`brand-mark ${className ?? ''}`} aria-hidden="true">
      <IconTv size={22} strokeWidth={2} />
    </span>
  );
}
